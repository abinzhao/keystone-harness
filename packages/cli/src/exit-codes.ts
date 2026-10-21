/**
 * The CLI exit-code contract — the stable, scriptable outcome surface.
 *
 * A caller (CI, a shell wrapper, another agent) branches on the process exit code
 * without parsing human output or re-deriving the verdict. The mapping below is a
 * *pure function* of the task status and the count of pending human decisions —
 * never of the model's prose — so re-running a replayable task yields the same
 * code for the same ledger.
 *
 *   0  proven             the Outcome Contract's required conditions were met at
 *                         the required evidence level; the task is delivered.
 *   3  needs attention    the run stopped because a human decision or contract
 *                         confirmation is outstanding. This is a *pause*, not a
 *                         failure: the task did not fail, it is waiting.
 *   1  did not prove      the run reached a non-proven end (`failed`,
 *                         `exited_gracefully`, `stopped`), landed in any other
 *                         non-delivered status, or the runtime errored before a
 *                         verdict. In CI this is a red build.
 *   2  usage error        the invocation itself was wrong (unknown command/flag,
 *                         missing required argument). It is the caller's fault,
 *                         not the task's, and no task was run.
 *
 * The load-bearing rule: **exit 0 is reserved for `proven` only.** Nothing else —
 * not a graceful stop, not a partial success, not "no work needed" — maps to 0.
 * That is what keeps the promise "exit 0 ⇒ the delivery conditions were proven"
 * and prevents a run that quietly did nothing from looking green in CI.
 */

import type { TaskStatus } from "@keystone/schemas";

/** Proven: completion conditions met at the required evidence level. */
export const EXIT_PROVEN = 0 as const;
/** Needs a human decision/contract confirmation; a pause, not a failure. */
export const EXIT_NEEDS_ATTENTION = 3 as const;
/** Did not prove: failed / stopped / graceful exit / any other non-delivered end. */
export const EXIT_FAILURE = 1 as const;
/** The invocation itself was wrong (bad flag/argument). */
export const EXIT_USAGE = 2 as const;

/**
 * Map a finished task to its exit code.
 *
 * `pendingInterventions` is the number of decisions the run stopped on because
 * it could not ask anyone (non-interactive mode). Even when the final status is
 * not literally `needs_attention`, an unanswered intervention means the task is
 * blocked on a human → exit 3, never 0 and never 1.
 */
export function exitCodeForTask(status: TaskStatus, pendingInterventions: number): number {
  if (status === "proven") return EXIT_PROVEN;
  if (
    status === "needs_attention" ||
    status === "awaiting_approval" ||
    pendingInterventions > 0
  ) {
    return EXIT_NEEDS_ATTENTION;
  }
  return EXIT_FAILURE;
}
