/**
 * Protocol invariants.
 *
 * These tests guard the *rules*, not the field lists: if someone adds an event
 * without a payload schema, loosens the evidence ladder, or makes a Lease
 * issuable by a model, these fail before the kernel can rely on the broken
 * version.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_STATUSES,
  CAPABILITIES,
  EVIDENCE_LEVELS,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  INTERVENTION_TRIGGERS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  capabilityLeaseSchema,
  decisionIsLive,
  evidenceRank,
  levelCanStandAlone,
  levelSatisfies,
  listSchemas,
  newId,
  outcomeContractSchema,
  requiredConditionIds,
  userDecisionSchema,
  type UserDecision,
} from "../src/index.ts";

test("every event type declares a payload schema entry", () => {
  for (const type of EVENT_TYPES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(EVENT_PAYLOAD_SCHEMAS, type),
      `event "${type}" has no entry in EVENT_PAYLOAD_SCHEMAS — add it explicitly ` +
        "(or map it to undefined) instead of leaving the payload unvalidated",
    );
  }
  assert.equal(Object.keys(EVENT_PAYLOAD_SCHEMAS).length, EVENT_TYPES.length);
});

test("only task.submitted carries no payload", () => {
  const payloadFree = EVENT_TYPES.filter((type) => EVENT_PAYLOAD_SCHEMAS[type] === undefined);
  assert.deepEqual(payloadFree, ["task.submitted"]);
});

test("evidence ladder: E0 never stands alone and higher levels satisfy lower", () => {
  assert.equal(levelCanStandAlone("E0"), false);
  assert.equal(levelCanStandAlone("E1"), false);
  assert.equal(levelCanStandAlone("E2"), true);
  assert.equal(levelCanStandAlone("E3"), true);
  assert.equal(levelCanStandAlone("E4"), true);

  assert.equal(levelSatisfies("E4", "E2"), true);
  assert.equal(levelSatisfies("E2", "E2"), true);
  assert.equal(levelSatisfies("E1", "E2"), false);
  assert.equal(evidenceRank("E0"), 0);
  assert.ok(evidenceRank("E4") > evidenceRank("E3"));
  assert.equal(EVIDENCE_LEVELS.length, 5);
});

test("transition table only references known statuses and events", () => {
  const known = new Set<string>(TASK_STATUSES);
  const events = new Set<string>(EVENT_TYPES);
  for (const transition of TASK_TRANSITIONS) {
    assert.ok(transition.from.length > 0, `${transition.event}: empty from`);
    assert.ok(transition.to.length > 0, `${transition.event}: empty to`);
    for (const status of transition.from) {
      assert.ok(known.has(status), `${transition.event}: unknown from status "${status}"`);
    }
    for (const status of transition.to) {
      assert.ok(known.has(status), `${transition.event}: unknown to status "${status}"`);
    }
    // Transition events must be real event types so the kernel can validate
    // their payloads without a second vocabulary.
    assert.ok(
      events.has(transition.event),
      `transition event "${transition.event}" is not a known event type`,
    );
  }
});

test("proven is reachable only through a proof verdict", () => {
  const intoProven = TASK_TRANSITIONS.filter((transition) => transition.to.includes("proven"));
  assert.equal(intoProven.length, 1);
  assert.deepEqual(intoProven[0]?.from, ["verifying"]);
  assert.equal(intoProven[0]?.event, "proof.satisfied");

  // Terminal and active sets must not overlap, and proven is terminal.
  assert.ok(TERMINAL_STATUSES.includes("proven"));
  for (const status of ACTIVE_STATUSES) {
    assert.ok(!TERMINAL_STATUSES.includes(status), `${status} is both active and terminal`);
  }
});

test("a contract must carry at least one condition and one exit condition", () => {
  const base = {
    contractId: newId("contract"),
    version: 1,
    taskId: newId("task"),
    projectId: newId("proj"),
    createdAt: new Date().toISOString(),
    createdBy: "kernel" as const,
    goal: "Fix duplicate session refresh",
    scope: { include: [], exclude: [], unknown: [] },
    invariants: [],
    budget: { maxTokens: 100, maxWallClockMs: 1000, maxRetries: 2 },
    autonomy: {
      projectId: newId("proj"),
      readPaths: ["**"],
      writePaths: ["src/**"],
      allowedCommands: ["pnpm"],
      allowedHosts: [],
      allowedCredentials: [],
      externalSystems: "none" as const,
      maxReversibility: "reversible" as const,
      untrustedContentEgress: "deny_all" as const,
      budget: { maxTokens: 100, maxWallClockMs: 1000, maxRetries: 2 },
      updatedAt: new Date().toISOString(),
      updatedBy: "user" as const,
      widenedBy: [],
    },
    uncertainties: [],
    interventionTriggers: [...INTERVENTION_TRIGGERS],
    exitConditions: [{ exitId: "exit.budget", kind: "budget_exhausted" as const, description: "budget out" }],
    status: "ready" as const,
    schemaVersion: "keystone.contract.outcome@1.0.0" as const,
    completionConditions: [
      {
        conditionId: "cond.tests",
        description: "target tests pass",
        verifier: { kind: "test" as const, id: "verifier.test", version: "1.0.0" },
        minEvidenceLevel: "E2" as const,
        requiresIndependence: false,
        required: true,
      },
    ],
  };

  const parsed = outcomeContractSchema.parse(base);
  assert.deepEqual(requiredConditionIds(parsed), ["cond.tests"]);

  assert.throws(
    () => outcomeContractSchema.parse({ ...base, completionConditions: [] }),
    /fewer than 1/,
  );
  assert.throws(
    () => outcomeContractSchema.parse({ ...base, exitConditions: [] }),
    /fewer than 1/,
  );
});

test("a lease cannot be issued by anything but the kernel", () => {
  const lease = {
    leaseId: newId("lease"),
    taskId: newId("task"),
    branchId: newId("branch"),
    subject: { kind: "builder_loop" as const, id: "builder" },
    capability: "fs.write" as const,
    resource: { kind: "paths" as const, values: ["src/auth/**"], mode: "write" as const },
    constraints: {},
    budget: { maxCalls: 5 },
    scopeDigest: "a".repeat(64),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedBy: "kernel" as const,
    status: "active" as const,
    consumedCalls: 0,
  };
  assert.equal(capabilityLeaseSchema.parse(lease).issuedBy, "kernel");
  assert.throws(
    () => capabilityLeaseSchema.parse({ ...lease, issuedBy: "model" }),
    /expected literal "kernel"/,
  );
  // Empty resource values would mean "no restriction", so they are rejected.
  assert.throws(
    () => capabilityLeaseSchema.parse({ ...lease, resource: { kind: "paths", values: [] } }),
    /fewer than 1/,
  );
});

test("a user decision can only be recorded by the user", () => {
  const decision = {
    decisionId: newId("dec"),
    taskId: newId("task"),
    branchId: newId("branch"),
    at: new Date().toISOString(),
    decision: "allow" as const,
    rationale: "narrowed to src/auth",
    appliesTo: { resources: ["src/auth/**"] },
    recordedBy: "user" as const,
  };
  assert.equal(userDecisionSchema.parse(decision).recordedBy, "user");
  assert.throws(
    () => userDecisionSchema.parse({ ...decision, recordedBy: "model" }),
    /expected literal "user"/,
  );
});

test("decision liveness honours allow/deny and expiry", () => {
  const now = new Date("2026-10-19T06:00:00.000Z");
  const iso = (value: string): NonNullable<UserDecision["appliesTo"]["expiresAt"]> =>
    value as NonNullable<UserDecision["appliesTo"]["expiresAt"]>;
  const base = {
    decisionId: newId("dec"),
    taskId: newId("task"),
    branchId: newId("branch"),
    at: iso("2026-10-19T05:00:00.000Z"),
    rationale: "test",
    recordedBy: "user" as const,
  };
  const live = (partial: Partial<UserDecision>): UserDecision =>
    ({ ...base, decision: "allow", appliesTo: { resources: [] }, ...partial }) as UserDecision;

  assert.equal(decisionIsLive(live({}), now), true);
  assert.equal(decisionIsLive(live({ decision: "deny" }), now), false);
  assert.equal(decisionIsLive(live({ decision: "expire" }), now), false);
  assert.equal(
    decisionIsLive(live({ appliesTo: { resources: [], expiresAt: iso("2026-10-19T05:59:00.000Z") } }), now),
    false,
  );
  assert.equal(
    decisionIsLive(live({ appliesTo: { resources: [], expiresAt: iso("2026-10-19T06:01:00.000Z") } }), now),
    true,
  );
});

test("capability vocabulary is closed and unique", () => {
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length);
  assert.ok(CAPABILITIES.includes("fs.write"));
  assert.ok(CAPABILITIES.includes("credential.use"));
});

test("the schema registry is complete and exports JSON Schema", () => {
  const schemas = listSchemas();
  assert.ok(schemas.length >= 80, `expected a full protocol, found ${schemas.length} schemas`);
  for (const schema of schemas) {
    const json = schema.toJsonSchema();
    assert.equal(typeof json["$id"], "string");
    assert.ok(Object.keys(json).length > 2, `${schema.id} produced an empty schema`);
  }
  const ids = schemas.map((schema) => schema.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate schema id");
});
