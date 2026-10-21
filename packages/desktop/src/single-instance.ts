/**
 * Single-instance enforcement for the desktop shell.
 *
 * A desktop app is a place: the user expects one window, one runtime, one place
 * to look. Two shells would each spawn their own `keystone serve` child and fight
 * over loopback ports and the workspace writer lock, so the second instance must
 * not start a second runtime.
 *
 * The lock is a tiny file holding the pid of the owning process. It is advisory
 * by design: a stale lock (a process that crashed without cleaning up) is
 * detected by checking whether the pid is alive, and then replaced — we would
 * rather start than wedge the app forever.
 */

import { existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface InstanceLock {
  readonly path: string;
  readonly holderPid: number;
  /** Release the lock. Safe to call more than once. */
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    // Signal 0 asks the OS whether the process exists / is signalable, without
    // delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process (stale lock). EPERM means another user owns a live
    // process — treat that as alive, i.e. genuinely busy.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the desktop lock. Resolves to the held lock when this instance owns
 * it, or rejects with a descriptive error when a live instance already holds it.
 */
export async function acquireInstanceLock(homeDir: string): Promise<InstanceLock> {
  const path = join(homeDir, "desktop.lock");
  if (existsSync(path)) {
    const existing = await readHolder(path).catch(() => undefined);
    if (existing !== undefined && existing !== process.pid && processAlive(existing)) {
      throw new InstanceAlreadyRunningError(existing);
    }
    // Stale (or self) lock: overwrite it below.
  }

  await writeFile(path, `${process.pid}\n`, { mode: 0o600 });
  let released = false;
  return {
    path,
    holderPid: process.pid,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await unlink(path).catch(() => undefined);
    },
  };
}

async function readHolder(path: string): Promise<number | undefined> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const pid = Number(text.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export class InstanceAlreadyRunningError extends Error {
  readonly holderPid: number;
  constructor(pid: number) {
    super(`a Keystone desktop instance is already running (pid ${pid})`);
    this.name = "InstanceAlreadyRunningError";
    this.holderPid = pid;
  }
}
