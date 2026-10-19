/**
 * `foldTaskState` — the only way a task status comes into existence.
 *
 * The fold is pure: given the same events it produces the same state, on any
 * machine, in any process (PRD NFR-REL-05). Nothing here reads a clock, a file
 * or a model; every timestamp comes from the event itself.
 *
 * Payload fields are read through `payloadOf`, which is typed by the schema of
 * that event type. Payloads are validated once, when the event is appended, and
 * the chain is verified when the ledger is read — so the fold can be a pure
 * projection rather than a second validator.
 */

import {
  runEventSchema,
  taskStateSchema,
  type EventType,
  type RunEvent,
  type TaskState,
  type TaskStatus,
} from "@keystone/schemas";

import { assertTransition } from "./transitions.ts";

export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

const ZERO_BUDGET = { tokens: 0, retries: 0, wallClockMs: 0, costUsd: 0 };

/**
 * Stage follows the status rather than the triggering event: a task that is
 * `executing` is in the modifying stage regardless of which event got it there,
 * and a resumed task lands on the stage its status implies.
 */
function stageForStatus(status: TaskStatus, current: TaskState["stage"]): TaskState["stage"] {
  switch (status) {
    case "draft":
    case "defining":
      return "understanding";
    case "ready":
    case "awaiting_approval":
      return "planning";
    case "executing":
    case "auto_repairing":
      return "modifying";
    case "verifying":
      return "verifying";
    case "proven":
    case "exited_gracefully":
      return "delivering";
    case "needs_attention":
    case "paused":
    case "resuming":
    case "failed":
    case "stopped":
      return current;
  }
}

function requireState(state: TaskState | undefined, event: RunEvent): TaskState {
  if (state === undefined) {
    throw new FoldError(
      `event "${event.type}" at seq ${event.seq} arrived before task.created; ` +
        "a ledger must open with task.created",
    );
  }
  return state;
}

/** Read a payload field with the type its schema declares. */
function readField<T>(payload: Record<string, unknown>, key: string): T | undefined {
  const value = payload[key];
  return value === undefined ? undefined : (value as T);
}

function readArray<T>(payload: Record<string, unknown>, key: string): T[] {
  const value = payload[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export function foldTaskState(events: readonly RunEvent[]): TaskState {
  let state: TaskState | undefined;

  for (const event of events) {
    state = applyEvent(state, event);
  }

  if (state === undefined) {
    throw new FoldError("ledger is empty; there is no task.created event to fold");
  }
  return taskStateSchema.parse(state) as TaskState;
}

function applyEvent(state: TaskState | undefined, event: RunEvent): TaskState {
  const payload = event.payload;

  if (event.type === "task.created") {
    if (state !== undefined) {
      throw new FoldError(`duplicate task.created at seq ${event.seq}`);
    }
    const projectId = readField<string>(payload, "projectId");
    if (projectId === undefined) {
      throw new FoldError("task.created is missing projectId");
    }
    return {
      taskId: event.taskId,
      projectId,
      branchId: event.branchId,
      status: "draft",
      stage: "understanding",
      seq: event.seq,
      createdAt: event.at,
      updatedAt: event.at,
      budgetUsed: { ...ZERO_BUDGET },
      pendingInterventions: [],
      outstandingEvidence: [],
      activeLeaseIds: [],
    } as unknown as TaskState;
  }

  const current = requireState(state, event);
  const next = { ...current, seq: event.seq, updatedAt: event.at } as TaskState;
  const mutable = next as unknown as Record<string, unknown>;

  switch (event.type) {
    case "task.status_changed": {
      const from = readField<TaskStatus>(payload, "from");
      const to = readField<TaskStatus>(payload, "to");
      const cause = readField<EventType>(payload, "event");
      if (from === undefined || to === undefined || cause === undefined) {
        throw new FoldError(`task.status_changed at seq ${event.seq} is missing from/to/event`);
      }
      if (from !== current.status) {
        throw new FoldError(
          `task.status_changed at seq ${event.seq} claims from=${from} but the folded status is ${current.status}`,
        );
      }
      // Re-check the transition here as well: a ledger that was tampered with,
      // or written by an older kernel, must not be able to invent a status.
      assertTransition(from, cause, to);
      mutable["status"] = to;
      break;
    }

    case "contract.compiled":
    case "contract.revised": {
      const contract = payload["contract"];
      if (event.type === "contract.compiled") {
        mutable["contractId"] = readField<string>(payload, "contractId");
        mutable["contractVersion"] = readField<number>(payload, "version");
      } else if (contract !== undefined && typeof contract === "object") {
        const asRecord = contract as Record<string, unknown>;
        mutable["contractId"] = asRecord["contractId"];
        mutable["contractVersion"] = asRecord["version"];
      }
      break;
    }

    case "budget.consumed": {
      const delta = payload["delta"];
      if (delta !== undefined && typeof delta === "object") {
        const d = delta as Record<string, number>;
        mutable["budgetUsed"] = {
          tokens: current.budgetUsed.tokens + (d["tokens"] ?? 0),
          retries: current.budgetUsed.retries + (d["retries"] ?? 0),
          wallClockMs: current.budgetUsed.wallClockMs + (d["wallClockMs"] ?? 0),
          costUsd: current.budgetUsed.costUsd + (d["costUsd"] ?? 0),
        };
      }
      break;
    }

    case "context.plan_created":
      mutable["activeContextPlanId"] = readField<string>(payload, "planId");
      break;

    case "lease.issued": {
      const leaseId = readField<string>(payload, "leaseId");
      if (leaseId !== undefined && !current.activeLeaseIds.includes(leaseId as never)) {
        mutable["activeLeaseIds"] = [...current.activeLeaseIds, leaseId];
      }
      break;
    }

    case "lease.revoked":
    case "lease.consumed": {
      const leaseId = readField<string>(payload, "leaseId");
      mutable["activeLeaseIds"] = current.activeLeaseIds.filter((id) => id !== leaseId);
      break;
    }

    case "evidence.recorded": {
      const evidenceId = readField<string>(payload, "evidenceId");
      if (evidenceId !== undefined && !current.outstandingEvidence.includes(evidenceId as never)) {
        mutable["outstandingEvidence"] = [...current.outstandingEvidence, evidenceId];
      }
      break;
    }

    case "evidence.invalidated": {
      const invalidated = new Set(readArray<string>(payload, "evidenceIds"));
      mutable["outstandingEvidence"] = current.outstandingEvidence.filter(
        (id) => !invalidated.has(id),
      );
      break;
    }

    case "checkpoint.created": {
      // A checkpoint restores exactly; adopting its lists keeps the fold aligned
      // with what a resume would reconstruct (ADR-0003).
      mutable["activeCheckpointId"] = readField<string>(payload, "checkpointId");
      if (Array.isArray(payload["evidenceIds"])) {
        mutable["outstandingEvidence"] = readArray<string>(payload, "evidenceIds");
      }
      if (Array.isArray(payload["activeLeaseIds"])) {
        mutable["activeLeaseIds"] = readArray<string>(payload, "activeLeaseIds");
      }
      break;
    }

    case "intervention.requested": {
      const interventionId = readField<string>(payload, "interventionId");
      if (
        interventionId !== undefined &&
        !current.pendingInterventions.includes(interventionId as never)
      ) {
        mutable["pendingInterventions"] = [...current.pendingInterventions, interventionId];
      }
      break;
    }

    case "intervention.decided": {
      const interventionId = readField<string>(payload, "interventionId");
      if (interventionId !== undefined) {
        mutable["pendingInterventions"] = current.pendingInterventions.filter(
          (id) => id !== interventionId,
        );
      }
      break;
    }

    case "degradation.applied": {
      const mode = readField<string>(payload, "mode");
      const reason = readField<string>(payload, "reason");
      if (mode !== undefined && reason !== undefined) {
        mutable["degradation"] = {
          mode,
          reason,
          capabilitiesLost: readArray<string>(payload, "capabilitiesLost"),
        };
      }
      break;
    }

    case "proof.satisfied": {
      mutable["proofGraphHash"] = readField<string>(payload, "proofGraphHash");
      mutable["provenAt"] = event.at;
      mutable["proofInvalidated"] = undefined;
      break;
    }

    case "proof.invalidated": {
      mutable["proofInvalidated"] = {
        at: event.at,
        reason: readField<string>(payload, "reason") ?? "unknown",
      };
      break;
    }

    case "task.stopped":
    case "task.cancelled":
      mutable["stopReason"] = readField<string>(payload, "reason");
      break;

    case "exit.conditions_met":
      mutable["exitReason"] = readField<string>(payload, "description");
      break;

    case "task.failed":
      mutable["errorSummary"] = readField<string>(payload, "message");
      break;

    default:
      break;
  }

  // The kernel never widens a status by accident: re-validating here means a
  // hand-edited ledger cannot produce a state machine violation.
  mutable["stage"] = stageForStatus(next.status, current.stage);
  return taskStateSchema.parse(next) as TaskState;
}

export function validateEvent(event: unknown): RunEvent {
  return runEventSchema.parse(event) as RunEvent;
}
