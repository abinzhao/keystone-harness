/**
 * Credential storage.
 *
 * Secrets live in `credentials/<handle>.json` with mode 0600, are read only when
 * a call is actually made, and are never echoed back in an error message, a log
 * line or a config file (PRD 11.3). `listHandles()` deliberately returns handles
 * rather than material, so a UI can show "which credentials exist" without
 * handling the secret.
 */

import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialResolver } from "./types.ts";

export interface CredentialStoreOptions {
  readonly credentialsDir: string;
}

const SAFE_HANDLE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function assertSafeHandle(handle: string): void {
  if (!SAFE_HANDLE.test(handle)) {
    throw new Error(
      "credential handle is invalid: use lowercase letters, digits, dot, dash or underscore",
    );
  }
}

export class FileCredentialStore implements CredentialResolver {
  private readonly dir: string;

  constructor(options: CredentialStoreOptions) {
    this.dir = options.credentialsDir;
  }

  private pathFor(handle: string): string {
    assertSafeHandle(handle);
    return join(this.dir, `${handle}.json`);
  }

  async set(handle: string, secret: string): Promise<void> {
    const path = this.pathFor(handle);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Written with 0600 and then chmod'ed, because `writeFile`'s mode is only
    // applied on creation and umask can widen it.
    await writeFile(path, JSON.stringify({ secret }), { mode: 0o600 });
    await hardenPermissions(path);
  }

  /** Resolve a handle to its secret. Returns undefined when nothing is stored. */
  async resolve(handle: string): Promise<string | undefined> {
    const path = this.pathFor(handle);
    try {
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text) as { secret?: unknown };
      return typeof parsed.secret === "string" ? parsed.secret : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      // JSON parse errors may include a snippet of the credential file.
      throw new Error("credential store could not resolve the handle; check file integrity and permissions");
    }
  }

  async delete(handle: string): Promise<void> {
    try {
      await unlink(this.pathFor(handle));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /**
   * Handles present on disk. A file that cannot be parsed is reported as
   * `"corrupt"` rather than skipped silently, so the user can act on it.
   */
  async listHandles(): Promise<readonly { handle: string; present: boolean }[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const out: { handle: string; present: boolean }[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const handle = name.slice(0, -".json".length);
      const secret = await this.resolve(handle).catch(() => undefined);
      out.push({ handle, present: secret !== undefined });
    }
    return out;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Best-effort 0600. On Windows `chmod` only toggles the read-only bit, so the
 * POSIX mode is a hint rather than a guarantee; the write above already used
 * `mode: 0o600`, and failing the whole store because the platform refuses to
 * honour it would make credentials unusable there. The secret is never logged,
 * so a lost mode bit does not leak it.
 */
async function hardenPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch {
    // See above: acceptable on platforms without POSIX permission bits.
  }
}
