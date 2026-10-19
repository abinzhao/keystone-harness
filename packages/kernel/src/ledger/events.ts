/**
 * Event construction and payload validation.
 *
 * The kernel validates a payload against the schema registered for its type
 * *before* the event can be appended. An unvalidated event in the ledger would
 * make every future replay of that task untrustworthy, so this check is the
 * gate rather than a post-hoc audit.
 */

import {
  EVENT_PAYLOAD_SCHEMAS,
  canonicalJson,
  chainHash,
  newId,
  nowIso,
  runEventSchema,
  type EventActorKind,
  type EventType,
  type RunEvent,
  type Sha256Hex,
} from "@keystone/schemas";

export class EventValidationError extends Error {
  readonly eventType: string;
  constructor(eventType: string, message: string) {
    super(`invalid payload for "${eventType}": ${message}`);
    this.name = "EventValidationError";
    this.eventType = eventType;
  }
}

export interface BuildEventInput {
  readonly taskId: string;
  readonly branchId: string;
  readonly type: EventType;
  readonly payload: Record<string, unknown>;
  readonly actorKind: EventActorKind;
  readonly actorId: string;
  readonly at?: string;
  readonly causationId?: string;
}

export interface ChainPosition {
  readonly seq: number;
  readonly prevHash: Sha256Hex | null;
}

/**
 * Validate the payload for an event type. `task.submitted` carries no payload by
 * design (it is a pure signal); every other type must have a schema.
 */
export function validateEventPayload(type: EventType, payload: unknown): Record<string, unknown> {
  const schema = EVENT_PAYLOAD_SCHEMAS[type];
  if (schema === undefined) {
    throw new EventValidationError(type, "no payload schema is registered for this event type");
  }
  try {
    return schema.parse(payload) as Record<string, unknown>;
  } catch (error) {
    throw new EventValidationError(type, error instanceof Error ? error.message : String(error));
  }
}

/** Canonical bytes the event hash is computed over: everything except `hash`. */
export function eventHashInput(event: Omit<RunEvent, "hash">): string {
  return canonicalJson({
    eventId: event.eventId,
    taskId: event.taskId,
    branchId: event.branchId,
    seq: event.seq,
    type: event.type,
    at: event.at,
    actor: event.actor,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    causationId: event.causationId ?? null,
    prevHash: event.prevHash,
  });
}

export function computeEventHash(event: Omit<RunEvent, "hash">): Sha256Hex {
  return chainHash(event.prevHash, eventHashInput(event));
}

/**
 * Build a validated, hash-linked event. Callers must pass the current chain tip
 * so that no one can append an event without linking it to the existing history.
 */
export function buildEvent(input: BuildEventInput, position: ChainPosition): RunEvent {
  const payload =
    input.type === "task.submitted"
      ? {}
      : validateEventPayload(input.type, input.payload);

  const withoutHash = {
    eventId: newId("evt"),
    taskId: input.taskId,
    branchId: input.branchId,
    seq: position.seq,
    type: input.type,
    at: input.at ?? nowIso(),
    actor: { kind: input.actorKind, id: input.actorId },
    payload,
    schemaVersion: "keystone.run.event@1.0.0" as const,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    prevHash: position.prevHash,
  };

  const hash = computeEventHash(withoutHash as Omit<RunEvent, "hash">);
  return runEventSchema.parse({ ...withoutHash, hash }) as RunEvent;
}

/** Structural check of a stored event, including its hash link. */
export function verifyStoredEvent(
  event: RunEvent,
  expectedPrevHash: Sha256Hex | null,
): { ok: true } | { ok: false; reason: string } {
  if (event.prevHash !== expectedPrevHash) {
    return {
      ok: false,
      reason: `event ${event.seq} links to ${String(event.prevHash)} but the chain tip is ${String(expectedPrevHash)}`,
    };
  }
  const recomputed = computeEventHash({ ...event, hash: undefined } as unknown as Omit<RunEvent, "hash">);
  if (recomputed !== event.hash) {
    return {
      ok: false,
      reason: `event ${event.seq} hash mismatch: stored ${event.hash}, recomputed ${recomputed}`,
    };
  }
  if (event.type !== "task.submitted") {
    try {
      validateEventPayload(event.type, event.payload);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true };
}
