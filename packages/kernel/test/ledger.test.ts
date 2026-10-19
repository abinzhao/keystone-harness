import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  newId,
  outcomeContractSchema,
  type OutcomeContract,
  type RunEvent,
  type TaskStatus,
} from "@keystone/schemas";

import {
  FoldError,
  TransitionError,
  appendEvent,
  buildEvent,
  chainTip,
  foldTaskState,
  readLedger,
  verifyChain,
} from "../src/index.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keystone-ledger-"));
}

/**
 * Build a contract through the real schema so that the fixture cannot drift from
 * the protocol (a fake that no longer validates is worse than no fake).
 */
function contractFor(taskId: string, projectId: string): OutcomeContract {
  return outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId,
    projectId,
    createdAt: new Date().toISOString(),
    createdBy: "kernel",
    goal: "Fix duplicate session refresh after expiry",
    scope: {
      include: [{ kind: "glob", pattern: "src/auth/**", intent: "write" }],
      exclude: [],
      unknown: [],
    },
    invariants: [{ invariantId: "inv.public_api", description: "public auth API unchanged" }],
    completionConditions: [
      {
        conditionId: "cond.unit",
        description: "auth unit tests pass",
        verifier: { kind: "test", id: "verifier.test", version: "1.0.0" },
        minEvidenceLevel: "E2",
        requiresIndependence: false,
        required: true,
      },
    ],
    budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
    autonomy: {
      projectId,
      readPaths: ["**"],
      writePaths: ["src/auth/**"],
      allowedCommands: ["pnpm"],
      allowedHosts: [],
      allowedCredentials: [],
      externalSystems: "none",
      maxReversibility: "reversible",
      untrustedContentEgress: "deny_all",
      budget: { maxTokens: 200_000, maxWallClockMs: 1_800_000, maxRetries: 3 },
      updatedAt: new Date().toISOString(),
      updatedBy: "user",
      widenedBy: [],
    },
    uncertainties: [],
    interventionTriggers: ["ambiguity", "scope_expansion"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "token budget exhausted" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
}

interface LedgerFixture {
  readonly taskId: string;
  readonly branchId: string;
  readonly projectId: string;
  readonly events: readonly RunEvent[];
}

/** Build a short but complete run: created -> defining -> ready -> executing. */
function buildFixture(options: { readonly stopAfterStart?: boolean } = {}): LedgerFixture {
  const taskId = newId("task");
  const branchId = newId("branch");
  const projectId = newId("proj");
  const events: RunEvent[] = [];

  const push = (
    type: Parameters<typeof buildEvent>[0]["type"],
    payload: Record<string, unknown>,
  ): RunEvent => {
    const event = buildEvent(
      { taskId, branchId, type, payload, actorKind: "kernel", actorId: "kernel" },
      chainTip(events),
    );
    events.push(event);
    return event;
  };

  const status = (from: TaskStatus, cause: string, to: TaskStatus): RunEvent =>
    push("task.status_changed", { from, to, event: cause });

  push("task.created", {
    projectId,
    request: "fix duplicate session refresh",
    requestedBy: "cli",
    references: [],
  });
  status("draft", "task.submitted", "defining");

  const contract = contractFor(taskId, projectId);
  push("contract.compiled", contract as unknown as Record<string, unknown>);
  status("defining", "contract.compiled", "ready");

  if (options.stopAfterStart !== true) {
    push("task.started", {
      contractId: contract.contractId,
      contractVersion: contract.version,
      authorization: "policy_default",
    });
    status("ready", "task.started", "executing");
  }

  return { taskId, branchId, projectId, events };
}

test("ledger round-trips events and verifies the hash chain", async () => {
  const dir = await tempDir();
  try {
    const fixture = buildFixture();
    const file = join(dir, "ledger.jsonl");
    for (const event of fixture.events) await appendEvent(file, event);

    const read = await readLedger(file);
    assert.equal(read.tornTail, false);
    assert.deepEqual(read.integrity, { ok: true });
    assert.equal(read.events.length, fixture.events.length);
    assert.deepEqual(read.events, fixture.events);
    assert.equal(read.fileHash.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chain verification detects an edited event", async () => {
  const dir = await tempDir();
  try {
    const fixture = buildFixture();
    const file = join(dir, "ledger.jsonl");
    for (const event of fixture.events) await appendEvent(file, event);

    const text = await readFile(file, "utf8");
    const lines = text.trimEnd().split("\n");
    const tampered = (lines[0] ?? "").replace('"fix duplicate session refresh"', '"something else"');
    lines[0] = tampered;
    await writeFile(file, `${lines.join("\n")}\n`);

    const read = await readLedger(file);
    assert.equal(read.integrity.ok, false);
    assert.equal(read.integrity.brokenAt, 1);
    assert.match(String(read.integrity.reason), /hash mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chain verification detects a dropped event", async () => {
  const dir = await tempDir();
  try {
    const fixture = buildFixture();
    const file = join(dir, "ledger.jsonl");
    for (const event of fixture.events) await appendEvent(file, event);

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    lines.splice(1, 1);
    await writeFile(file, `${lines.join("\n")}\n`);

    const read = await readLedger(file);
    assert.equal(read.integrity.ok, false);
    assert.match(String(read.integrity.reason), /expected seq 2 but found 3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn trailing record is dropped and reported, not parsed", async () => {
  const dir = await tempDir();
  try {
    const fixture = buildFixture();
    const file = join(dir, "ledger.jsonl");
    for (const event of fixture.events) await appendEvent(file, event);

    // Simulate a crash mid-append: a partial JSON line with no newline.
    const text = await readFile(file, "utf8");
    await writeFile(file, `${text}{"eventId":"evt_partial","seq":`);

    const read = await readLedger(file);
    assert.equal(read.tornTail, true);
    assert.equal(read.integrity.ok, true);
    assert.equal(read.events.length, fixture.events.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folding produces the expected status and is deterministic across replays", () => {
  const fixture = buildFixture();
  const first = foldTaskState(fixture.events);
  const second = foldTaskState(fixture.events);

  assert.equal(first.status, "executing");
  assert.equal(first.stage, "modifying");
  assert.equal(first.seq, fixture.events.length);
  assert.equal(first.projectId, fixture.projectId);
  assert.notEqual(first.contractId, undefined);
  assert.equal(first.contractVersion, 1);
  // Replay equality is the guarantee behind NFR-REL-05.
  assert.deepEqual(first, second);
});

test("role of every event is reflected in folded state", () => {
  const fixture = buildFixture();
  const events = [...fixture.events];

  const push = (
    type: Parameters<typeof buildEvent>[0]["type"],
    payload: Record<string, unknown>,
  ): void => {
    events.push(
      buildEvent(
        { taskId: fixture.taskId, branchId: fixture.branchId, type, payload, actorKind: "tool", actorId: "tool.fs" },
        chainTip(events),
      ),
    );
  };

  const leaseId = newId("lease");
  const evidenceId = newId("evd");
  const interventionId = newId("intr");
  const checkpointId = newId("ckpt");

  push("lease.issued", {
    leaseId,
    taskId: fixture.taskId,
    branchId: fixture.branchId,
    subject: { kind: "builder_loop", id: "builder" },
    capability: "fs.write",
    resource: { kind: "paths", values: ["src/auth/x.ts"], mode: "write" },
    constraints: {},
    budget: { maxCalls: 3 },
    scopeDigest: "b".repeat(64),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedBy: "kernel",
    status: "active",
    consumedCalls: 0,
  });
  push("budget.consumed", {
    delta: { tokens: 1200, retries: 0, wallClockMs: 900, costUsd: 0.02 },
    reason: "step.localize.model_call",
    measured: true,
  });
  push("intervention.requested", {
    interventionId,
    taskId: fixture.taskId,
    branchId: fixture.branchId,
    at: new Date().toISOString(),
    trigger: "scope_expansion",
    question: "May Keystone edit src/billing/invoice.ts?",
    whyUserNeeded: "the file is outside the declared write scope",
    ifIgnoredImpact: "the refresh bug cannot be fixed",
    recommendedAction: { optionId: "extend", rationale: "smallest change that fixes the root cause" },
    options: [
      {
        optionId: "extend",
        label: "Extend scope to src/billing",
        effectOnScope: "adds src/billing/**",
        effectOnBudget: "no change",
        widensEnvelope: true,
        grants: ["fs.write"],
      },
    ],
    blockingActionRefs: [],
    contextSummary: "duplicate refresh originates in the billing callback",
    relatedEvidenceIds: [],
  });
  push("evidence.recorded", {
    evidenceId,
    taskId: fixture.taskId,
    branchId: fixture.branchId,
    conditionIds: ["cond.unit"],
    level: "E2",
    producer: { kind: "verifier", id: "verifier.test", version: "1.0.0" },
    independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
    provenance: {
      provenanceId: newId("prov"),
      sourceKind: "verifier",
      trustLevel: "verified",
      locator: "pnpm test",
      derivedFrom: [],
      invalidatedBy: [],
      observedAt: new Date().toISOString(),
    },
    workspaceSnapshotId: newId("snap"),
    contractId: "contract_x",
    contractVersion: 1,
    observation: { summary: "12 tests passed", exitCode: 0, truncated: false },
    createdAt: new Date().toISOString(),
    contentHash: "c".repeat(64),
    status: "valid",
    invalidatedBy: [],
  });
  push("checkpoint.created", {
    checkpointId,
    taskId: fixture.taskId,
    branchId: fixture.branchId,
    seq: events.length,
    createdAt: new Date().toISOString(),
    reason: "pre_verification",
    state: foldTaskState(events.slice(0, -1)),
    verification: {},
    pendingStepIds: [],
    evidenceIds: [evidenceId],
    artifactRefs: [],
    activeLeaseIds: [leaseId],
    extensions: [],
    integrity: "d".repeat(64),
  });

  const state = foldTaskState(events);
  assert.equal(state.budgetUsed.tokens, 1200);
  assert.equal(state.budgetUsed.costUsd, 0.02);
  assert.deepEqual(state.pendingInterventions, [interventionId]);
  assert.deepEqual(state.outstandingEvidence, [evidenceId]);
  assert.deepEqual(state.activeLeaseIds, [leaseId]);
  assert.equal(state.activeCheckpointId, checkpointId);
});

test("an illegal status transition in the ledger stops the fold", () => {
  const fixture = buildFixture();
  const events = [...fixture.events];
  events.push(
    buildEvent(
      {
        taskId: fixture.taskId,
        branchId: fixture.branchId,
        type: "task.status_changed",
        // Verifying was never reached; this is exactly the "just set it to
        // proven" shortcut the kernel must refuse.
        payload: { from: "verifying", to: "proven", event: "proof.satisfied" },
        actorKind: "model",
        actorId: "model.fake",
      },
      chainTip(events),
    ),
  );

  assert.throws(() => foldTaskState(events), FoldError);
});

test("status changes cannot be forged by a non-kernel actor", () => {
  const fixture = buildFixture();
  const events = [...fixture.events];
  // From the correct status, but the transition table does not allow going
  // straight from executing to proven.
  events.push(
    buildEvent(
      {
        taskId: fixture.taskId,
        branchId: fixture.branchId,
        type: "task.status_changed",
        payload: { from: "executing", to: "proven", event: "proof.satisfied" },
        actorKind: "model",
        actorId: "model.fake",
      },
      chainTip(events),
    ),
  );
  assert.throws(() => foldTaskState(events), TransitionError);
});

test("an event carrying a payload that does not match its schema is rejected", () => {
  const fixture = buildFixture();
  assert.throws(
    () =>
      buildEvent(
        {
          taskId: fixture.taskId,
          branchId: fixture.branchId,
          type: "budget.consumed",
          payload: { delta: { tokens: "lots" }, reason: "x", measured: true },
          actorKind: "kernel",
          actorId: "kernel",
        },
        chainTip(fixture.events),
      ),
    /invalid payload for "budget.consumed"/,
  );
});

test("folding an empty ledger is an error rather than an empty state", () => {
  assert.throws(() => foldTaskState([]), /no task.created event/);
});

test("verifyChain reports the genesis expectations for a fresh chain", () => {
  assert.deepEqual(chainTip([]), { seq: 1, prevHash: null });
  const fixture = buildFixture();
  const tip = chainTip(fixture.events);
  assert.equal(tip.seq, fixture.events.length + 1);
  assert.equal(tip.prevHash, fixture.events[fixture.events.length - 1]?.hash);
  assert.deepEqual(verifyChain([]), { ok: true });
});
