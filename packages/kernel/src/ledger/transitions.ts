/**
 * Status transition rules.
 *
 * The table lives in the protocol package so clients can explain a transition
 * without reimplementing it; enforcement lives here. An event that is not in the
 * table is rejected and the rejection recorded — no "nearest sensible state".
 */

import { TASK_TRANSITIONS, type TaskStatus } from "@keystone/schemas";

export class TransitionError extends Error {
  readonly from: TaskStatus;
  readonly event: string;
  readonly to: TaskStatus;
  constructor(from: TaskStatus, event: string, to: TaskStatus, detail: string) {
    super(`cannot apply "${event}" in ${from} -> ${to}: ${detail}`);
    this.name = "TransitionError";
    this.from = from;
    this.event = event;
    this.to = to;
  }
}

export function allowedTargets(from: TaskStatus, event: string): readonly TaskStatus[] {
  const matching = TASK_TRANSITIONS.filter(
    (transition) => transition.event === event && transition.from.includes(from),
  );
  const targets: TaskStatus[] = [];
  for (const transition of matching) {
    for (const target of transition.to) {
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

export function canTransition(from: TaskStatus, event: string, to: TaskStatus): boolean {
  return allowedTargets(from, event).includes(to);
}

/**
 * Throws rather than coercing. A wrong status is indistinguishable from a wrong
 * proof later, so an illegal transition must stop the run (PRD 7.2, 9.1).
 */
export function assertTransition(from: TaskStatus, event: string, to: TaskStatus): void {
  const targets = allowedTargets(from, event);
  if (targets.length === 0) {
    throw new TransitionError(
      from,
      event,
      to,
      "no transition is defined for this event in this status",
    );
  }
  if (!targets.includes(to)) {
    throw new TransitionError(
      from,
      event,
      to,
      `allowed targets are ${targets.join(", ")}`,
    );
  }
}

/** User-facing description of what a transition requires and what happens if it
 * cannot proceed — used to explain a rejection without leaking internals. */
export function transitionRequirement(from: TaskStatus, event: string): string | undefined {
  const transition = TASK_TRANSITIONS.find(
    (candidate) => candidate.event === event && candidate.from.includes(from),
  );
  return transition?.requires;
}
