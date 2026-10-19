/**
 * Durable file primitives.
 *
 * Two requirements drive everything here (ADR-0003, PRD NFR-REL-08):
 *
 *  - A persisted write is either fully visible or not visible at all, so a
 *    reader never sees half a checkpoint.
 *  - A ledger append is durable before the action it records is considered to
 *    have happened, so a crash cannot leave an effect with no record of it.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export class LockUnavailableError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, holder: string) {
    super(`lock ${lockPath} is held by ${holder}`);
    this.name = "LockUnavailableError";
    this.lockPath = lockPath;
  }
}

/**
 * Atomic replace: write a sibling temp file, fsync it, rename over the target,
 * then fsync the directory so the rename itself survives a crash.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await safeUnlink(tmp);
    throw error;
  }
  await handle.close();

  try {
    await rename(tmp, filePath);
  } catch (error) {
    await safeUnlink(tmp);
    throw error;
  }
  await fsyncDir(dir);
}

/**
 * Durable append of one JSON line. The newline is included in the same write so
 * a reader can always distinguish a complete record from a torn tail.
 */
export async function appendLineDurable(filePath: string, line: string): Promise<void> {
  await ensureDir(dirname(filePath));
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextFile(filePath);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export interface JsonLinesRead<T> {
  readonly items: readonly T[];
  /**
   * True when the file did not end with a newline. The trailing partial record
   * is dropped and reported rather than parsed, so a crash mid-append cannot
   * corrupt the projection (NFR-REL-01).
   */
  readonly tornTail: boolean;
}

export async function readJsonLines<T>(filePath: string): Promise<JsonLinesRead<T>> {
  const text = await readTextFile(filePath);
  if (text === undefined) return { items: [], tornTail: false };

  const complete = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (complete) rawLines.pop();
  const last = rawLines.length - 1;
  const tornTail = !complete;

  const items: T[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (line === undefined || line === "") continue;
    if (tornTail && index === last) break;
    items.push(JSON.parse(line) as T);
  }
  return { items, tornTail };
}

async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch {
    // Directory fsync is unavailable on some platforms; the rename is still
    // ordered relative to the data fsync above.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Same: best effort.
  } finally {
    await handle.close();
  }
}

export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface LockOptions {
  /** A lock older than this is assumed to be from a crashed process. */
  readonly staleMs?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Free-form description of the holder, written into the lock file. */
  readonly holder?: string;
}

/**
 * Single-writer lock per task/branch.
 *
 * The kernel must guarantee one writer per task so that two clients cannot
 * interleave appends, but a crashed process must not lock a task forever —
 * hence staleness detection by mtime (PRD 9.6, NFR-REL-02).
 */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const staleMs = options.staleMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const holder = options.holder ?? `pid:${process.pid}`;
  const deadline = Date.now() + timeoutMs;

  await ensureDir(dirname(lockPath));

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${holder}\n${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        async release(): Promise<void> {
          await safeUnlink(lockPath);
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;

      const info = await stat(lockPath).catch(() => undefined);
      if (info === undefined) continue; // released between open and stat
      if (Date.now() - info.mtimeMs > staleMs) {
        await safeUnlink(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        const existing = (await readTextFile(lockPath))?.split("\n")[0] ?? "unknown";
        throw new LockUnavailableError(lockPath, existing);
      }
      await sleep(pollMs);
    }
  }
}

export async function withLock<T>(
  lockPath: string,
  options: LockOptions,
  action: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(lockPath, options);
  try {
    return await action();
  } finally {
    await handle.release();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
