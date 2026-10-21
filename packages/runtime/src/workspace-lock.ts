/**
 * Workspace-level single-writer admission.
 *
 * A standard run edits the user's working copy in place. Two such runs on the
 * same repository would interleave edits, invalidate each other's fingerprints,
 * and — because each task owns its kernel session — race on the same files. The
 * kernel already forbids two writers on one ledger (ADR-0003); this is the same
 * rule applied one layer up, to the *filesystem* the run mutates.
 *
 * The lock is deliberately in-memory and process-local: it is admission for one
 * runtime process, not a distributed lock. It is keyed by the canonical
 * workspace id (`projectIdForWorkspace`, realpath-derived) so a symlinked
 * checkout and its target contend on the same lock.
 *
 * Only standard runs take the lock. Isolated runs work in a throwaway worktree
 * and never touch the user's files, so they must not wait on it; replay and
 * minimal perform no new work at all.
 */

/**
 * Admission was refused because a standard run is already writing this workspace.
 *
 * This is a permanent refusal for *this* run, not a queue: the caller is told to
 * start in isolated mode instead, rather than being parked behind another task
 * that could run for hours.
 */
export class WorkspaceBusyError extends Error {
  readonly projectId: string;
  readonly holderTaskId: string | undefined;

  constructor(projectId: string, holder: { readonly taskId?: string | undefined }) {
    super(
      `workspace "${projectId}" is already busy: a standard-mode task is already writing to this ` +
        `working copy${holder.taskId === undefined ? "" : ` (task "${holder.taskId}")`}. ` +
        "Start this task in isolated mode instead, so it works in a separate worktree and the two " +
        "never touch the same files at once.",
    );
    this.name = "WorkspaceBusyError";
    this.projectId = projectId;
    this.holderTaskId = holder.taskId;
  }
}

interface LockEntry {
  /** Filled in once the session exists, so a refusal can name the current holder. */
  taskId: string | undefined;
  readonly acquiredAt: string;
}

export type WorkspaceLockRelease = () => void;

/**
 * A process-local map of canonical workspace id -> in-flight writer.
 *
 * `tryAcquire` is synchronous: the check-and-set happens inside one tick, so two
 * runTask calls racing past their `await projectIdForWorkspace` cannot both see
 * "free". That is what makes the overlap tests deterministic without a sleep.
 */
export class WorkspaceWriteAdmission {
  private readonly held = new Map<string, LockEntry>();

  /**
   * Take the lock for `projectId`. Throws `WorkspaceBusyError` if another writer
   * already holds it. Returns a release that is idempotent and safe to call from
   * a `finally` block on success, failure, or a user-initiated stop.
   */
  tryAcquire(projectId: string, acquiredAt: string): WorkspaceLockRelease {
    const existing = this.held.get(projectId);
    if (existing !== undefined) {
      throw new WorkspaceBusyError(projectId, existing);
    }
    this.held.set(projectId, { taskId: undefined, acquiredAt });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(projectId);
    };
  }

  /** Name the task that now holds a lock this runtime has already acquired. */
  noteHolder(projectId: string, taskId: string): void {
    const entry = this.held.get(projectId);
    if (entry !== undefined) entry.taskId = taskId;
  }

  /** Test introspection: whether a writer currently holds `projectId`. */
  isHeld(projectId: string): boolean {
    return this.held.has(projectId);
  }
}
