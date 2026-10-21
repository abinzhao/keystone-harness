/**
 * KernelSession behaviour.
 *
 * The ledger/fold layer has its own tests; these cover the *facade* — the part
 * that decides what an action is allowed to do and what it records. The
 * interesting cases are the refusals and the branch fork, because those are the
 * paths where a permissive implementation would look like it works.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  actionProposalSchema,
  autonomyEnvelopeSchema,
  newId,
  outcomeContractSchema,
  projectProfileSchema,
  userDecisionSchema,
  contentHash,
  type ActionProposal,
  type AutonomyEnvelope,
  type OutcomeContract,
  type ProjectId,
  type ProjectProfile,
} from "@keystone/schemas";

import {
  KernelError,
  KernelSession,
  resolveKeystonePaths,
  type ActionCapabilityResolver,
  type ContractProposal,
  type ContractProposalInput,
} from "../src/index.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keystone-kernel-"));
}

function profileFor(projectId: ProjectId): ProjectProfile {
  const now = new Date().toISOString();
  // Built through the schema so the fixture cannot drift from the protocol.
  return projectProfileSchema.parse({
    projectId,
    rootPath: "/tmp/fixture",
    name: "fixture",
    vcs: "git",
    languages: ["typescript"],
    packageManager: "pnpm",
    support: { status: "supported", reasons: ["package.json with a test script was found"] },
    commands: [
      { kind: "test", command: "pnpm run test", status: "identified", source: "package.json#scripts.test" },
    ],
    instructionFiles: [],
    createdAt: now,
    updatedAt: now,
  }) as ProjectProfile;
}

function autonomyFor(projectId: ProjectId, writePaths: readonly string[]): AutonomyEnvelope {
  return autonomyEnvelopeSchema.parse({
    projectId,
    readPaths: ["**"],
    writePaths: [...writePaths],
    allowedCommands: ["pnpm"],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 100_000, maxWallClockMs: 600_000, maxRetries: 2 },
    updatedAt: new Date().toISOString(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

function proposalFor(
  session: KernelSession,
  overrides: Record<string, unknown> = {},
): ActionProposal {
  return actionProposalSchema.parse({
    proposalId: newId("prop"),
    taskId: session.taskId,
    branchId: session.branchId,
    stepId: "step.localize",
    at: new Date().toISOString(),
    modelRef: { id: "scripted", provider: "keystone", modelName: "scripted-1" },
    intent: "write",
    tool: { id: "fs.write_file", version: "1.0.0" },
    parameters: { path: "src/auth/session.ts", content: "// fix" },
    rationale: "apply the fix",
    expectedEffects: [
      { kind: "file_modify", target: "src/auth/session.ts", description: "one refresh" },
    ],
    reversibility: "reversible",
    requestedCapabilities: ["fs.write"],
    producesEvidenceFor: [],
    ...overrides,
  }) as ActionProposal;
}

interface Started {
  readonly session: KernelSession;
  readonly home: string;
}

/**
 * A deterministic proposer for the kernel lifecycle tests. The kernel does not
 * draft engineering contracts (ADR-0006); these tests pin the state machine, so
 * they supply a controlled contract rather than the engineering pack's heuristics.
 */
function stubProposer(input: ContractProposalInput): ContractProposal {
  const referenced = (input.references ?? [])
    .filter((ref) => ref.kind === "file" || ref.kind === "directory")
    .map((ref) =>
      ref.kind === "file"
        ? ({ kind: "path", pattern: ref.value, intent: "write" } as const)
        : ({ kind: "directory", pattern: ref.value, intent: "write" } as const),
    );
  const include = referenced.length > 0 ? referenced : [{ kind: "directory", pattern: "src", intent: "write" } as const];
  const contract = outcomeContractSchema.parse({
    contractId: newId("contract"),
    version: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    createdAt: new Date().toISOString(),
    createdBy: "kernel",
    goal: input.request,
    scope: { include, exclude: [], unknown: [] },
    invariants: [],
    completionConditions: [
      {
        conditionId: "cond.target_tests",
        description: "the change passes the project's tests",
        verifier: { kind: "test", id: "verifier.test", version: "1.0.0" },
        minEvidenceLevel: "E2",
        requiresIndependence: false,
        required: true,
      },
    ],
    budget: input.budget ?? { maxTokens: 100_000, maxWallClockMs: 3_600_000, maxRetries: 3 },
    autonomy: input.autonomy,
    uncertainties: [],
    interventionTriggers: ["ambiguity"],
    exitConditions: [
      { exitId: "exit.budget", kind: "budget_exhausted", description: "the task budget is exhausted" },
    ],
    status: "ready",
    schemaVersion: "keystone.contract.outcome@1.0.0",
  }) as OutcomeContract;
  return { contract, questions: [] };
}

test("a reopened draft can receive local policy wiring without changing its created request", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const projectId = newId("proj") as ProjectId;
    const created = await KernelSession.create({
      paths,
      projectId,
      request: "independently inspect imported changes",
      references: [{ kind: "text", value: "untrusted imported candidate" }],
      requestedBy: "user",
    });

    const defining = await KernelSession.open({ paths, taskId: created.taskId });
    await defining.submit();
    await assert.rejects(
      defining.compile({
        profile: profileFor(projectId),
        autonomy: autonomyFor(projectId, ["src/**"]),
      }),
      (error: unknown) => error instanceof KernelError && error.code === "no_contract_proposer",
    );

    const continued = await (KernelSession.open as unknown as (input: Record<string, unknown>) => Promise<KernelSession>)({
      paths,
      taskId: created.taskId,
      actorId: "runtime",
      proposeContract: stubProposer,
      resolveAction: testActionResolver,
    });
    const proposal = await continued.compile({
      profile: profileFor(projectId),
      autonomy: autonomyFor(projectId, ["src/**"]),
    });
    assert.equal(proposal.contract.goal, "independently inspect imported changes");
    assert.deepEqual(
      continued.events().find((event) => event.type === "task.created")?.payload["references"],
      [{ kind: "text", value: "untrusted imported candidate" }],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * A deterministic action resolver for the kernel lifecycle tests. The kernel
 * resolves no intent→capability mapping itself (ADR-0006, M1); these tests pin
 * the *seam* and the lease state machine, so they supply a controlled resolver
 * that mirrors the engineering pack's mapping. The exact engineering behaviour
 * is pinned in `@keystone/pack-engineering`'s own regression test.
 */
const testActionResolver: ActionCapabilityResolver = (proposal) => {
  const capability = (): import("@keystone/schemas").Capability | undefined => {
    switch (proposal.intent) {
      case "read":
      case "search":
        return "fs.read";
      case "write":
        return "fs.write";
      case "delete":
        return "fs.delete";
      case "execute":
        return "cmd.exec";
      case "network":
        return "net.fetch";
      case "git":
        return proposal.requestedCapabilities.includes("git.write") ? "git.write" : "git.read";
      case "ask_user":
      case "finish":
        return undefined;
    }
  };
  const path =
    typeof proposal.parameters["path"] === "string"
      ? (proposal.parameters["path"] as string)
      : undefined;
  return {
    capability: capability(),
    resourceValues: path === undefined ? [] : [path],
  };
};

/** A task that has a contract and is executing — the state most work starts from. */
async function startTask(writePaths: readonly string[] = ["src/**"]): Promise<Started> {
  const home = await tempHome();
  const paths = resolveKeystonePaths(home);
  const projectId = newId("proj") as ProjectId;

  const session = await KernelSession.create({
    paths,
    projectId,
    request: "Fix the duplicate session refresh in src/auth/session.ts",
    references: [{ kind: "file", value: "src/auth/session.ts" }],
    actorId: "test",
    proposeContract: stubProposer,
    resolveAction: testActionResolver,
  });

  await session.submit();
  await session.compile({
    profile: profileFor(projectId),
    autonomy: autonomyFor(projectId, writePaths),
  });
  await session.start();
  return { session, home };
}

test("a task moves draft -> defining -> ready -> executing and refuses illegal repeats", async () => {
  const { session, home } = await startTask();
  try {
    assert.equal(session.state().status, "executing");
    assert.equal(session.state().stage, "modifying");
    const contract = session.contract();
    assert.ok(contract !== undefined);
    assert.equal(session.state().contractVersion, contract.version);

    await assert.rejects(() => session.start(), (error: unknown) => {
      assert.ok(error instanceof KernelError);
      assert.equal(error.code, "invalid_state");
      return true;
    });
    await assert.rejects(() => session.submit(), /cannot submit the task/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a write proposal inside scope is leased; outside scope it is refused and recorded", async () => {
  const { session, home } = await startTask();
  try {
    const contract = session.contract();
    assert.ok(contract !== undefined);

    const inside = proposalFor(session);

    const granted = await session.authorize(inside);
    assert.equal(granted.ok, true, granted.ok ? "" : granted.denial.detail);
    if (granted.ok) {
      assert.equal(granted.lease.issuedBy, "kernel");
      assert.deepEqual(granted.lease.resource.values, ["src/auth/session.ts"]);
    }

    const outside = proposalFor(session, {
      parameters: { path: "config/secrets.env", content: "x" },
      expectedEffects: [
        { kind: "file_create", target: "config/secrets.env", description: "leak" },
      ],
    });
    const refused = await session.authorize(outside);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.denial.code, "capability_outside_envelope");
      assert.match(refused.denial.detail, /outside the project's write boundary/);
    }

    const rejections = session
      .events()
      .filter((event) => event.type === "action.rejected");
    assert.equal(rejections.length, 1, "the refusal must be on the record");
    assert.equal(rejections[0]?.payload["code"], "envelope_exceeded");
    // No lease may exist for the refused action.
    const leases = session.events().filter((event) => event.type === "lease.issued");
    assert.equal(leases.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a read-only intent is never granted a write capability", async () => {
  const { session, home } = await startTask();
  try {
    const proposal = proposalFor(session, {
      intent: "read",
      tool: { id: "fs.read_file", version: "1.0.0" },
      parameters: { path: "src/auth/session.ts" },
      expectedEffects: [],
      requestedCapabilities: ["fs.write"],
      rationale: "read the file",
    });
    const result = await session.authorize(proposal);
    assert.equal(result.ok, true);
    if (result.ok) {
      // The intent decides the capability; a model asking for more gets the
      // capability its action actually needs.
      assert.equal(result.lease.capability, "fs.read");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a fork carries the parent history so the branch is independently verifiable", async () => {
  const { session, home } = await startTask();
  try {
    await session.checkpoint("pre_branch");
    const parentEvents = session.events().length;
    const parentStatus = session.state().status;

    const branch = await session.branch("alternative", "compare a different repair path");
    assert.match(branch.branchId, /^branch_/);
    assert.equal(branch.forkedFromBranchId, session.branchId);

    const forked = await KernelSession.open({
      paths: resolveKeystonePaths(home),
      taskId: session.taskId,
      branchId: branch.branchId,
    });
    assert.equal(forked.events().length, parentEvents, "the fork must include the parent history");
    assert.equal(forked.state().status, parentStatus);
    assert.equal(forked.replay().consistent, true);

    // Working on the branch must not touch the parent.
    await forked.pause("investigate an alternative", true);
    assert.equal(forked.state().status, "paused");
    const reopenedParent = await KernelSession.open({
      paths: resolveKeystonePaths(home),
      taskId: session.taskId,
    });
    assert.equal(reopenedParent.state().status, parentStatus, "the parent branch is unaffected");
    assert.equal(reopenedParent.events().length, parentEvents);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("opening a branch whose ledger was never seeded fails loudly instead of corrupting history", async () => {
  const { session, home } = await startTask();
  try {
    const { createBranch } = await import("../src/index.ts");
    const paths = resolveKeystonePaths(home);
    const contract = session.contract();
    assert.ok(contract !== undefined);

    // A branch record created without forking the history: the ledger file is
    // empty, so there is no verifiable chain to continue from.
    const orphan = await createBranch(paths, {
      taskId: session.taskId,
      label: "orphan",
      reason: "created without a fork",
      contractId: contract.contractId,
      contractVersion: contract.version,
    });

    await assert.rejects(
      () =>
        KernelSession.open({
          paths,
          taskId: session.taskId,
          branchId: orphan.branchId,
        }),
      (error: unknown) => {
        assert.ok(error instanceof KernelError);
        assert.equal(error.code, "branch_not_seeded");
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a corrupt ledger is refused rather than partially loaded", async () => {
  const { session, home } = await startTask();
  try {
    const { readFile, writeFile } = await import("node:fs/promises");
    const paths = resolveKeystonePaths(home);
    const ledgerFile = paths.ledgerFile(session.taskId);
    // Change one recorded value. The hash chain must notice, and the session must
    // refuse to load rather than fold a ledger it cannot vouch for.
    const text = await readFile(ledgerFile, "utf8");
    await writeFile(ledgerFile, text.replace('"executing"', '"defining"'));

    await assert.rejects(
      () => KernelSession.open({ paths, taskId: session.taskId }),
      (error: unknown) => {
        assert.ok(error instanceof KernelError);
        assert.equal(error.code, "ledger_integrity");
        assert.match(error.message, /failed integrity verification/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("proof export is a deterministic query over the same ledger", async () => {
  const { session, home } = await startTask();
  try {
    // No evidence has been recorded, so the contract cannot be satisfied — but
    // the *answer* must be the same every time it is asked.
    const first = await session.exportProof({ changedPaths: [] });
    const second = await session.exportProof({ changedPaths: [] });
    assert.equal(first.outcome, "not_proven");
    assert.equal(first.proofGraphHash, second.proofGraphHash);
    assert.equal(first.packageId, second.packageId);
    assert.ok(
      first.conditions.some((condition) => condition.required && !condition.satisfied),
      "the unsatisfied required condition must be visible",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the autonomy envelope cannot be widened by the task itself", async () => {
  const { session, home } = await startTask(["src/**"]);
  try {
    const contract = session.contract();
    assert.ok(contract !== undefined);
    // The contract carries a snapshot of the envelope; there is no kernel API
    // that lets a running task edit it, which is the point.
    assert.deepEqual(contract.autonomy.writePaths, ["src/**"]);
    assert.equal(contract.autonomy.updatedBy, "user");
    assert.deepEqual(contract.autonomy.widenedBy, []);

    const api = Object.getOwnPropertyNames(KernelSession.prototype);
    assert.ok(
      !api.some((name) => /widen|autonomy/i.test(name)),
      `no method may widen the envelope from inside a task, found: ${api.join(", ")}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("authorising fails loudly when no action resolver is wired (a composition error)", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const projectId = newId("proj") as ProjectId;
    // The session has a contract proposer but deliberately no action resolver.
    const session = await KernelSession.create({
      paths,
      projectId,
      request: "apply a fix",
      actorId: "test",
      proposeContract: stubProposer,
    });
    await session.submit();
    await session.compile({
      profile: profileFor(projectId),
      autonomy: autonomyFor(projectId, ["src/**"]),
    });
    await session.start();

    await assert.rejects(
      () => session.authorize(proposalFor(session)),
      (error: unknown) => {
        assert.ok(error instanceof KernelError);
        assert.equal(error.code, "no_action_resolver");
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a resolver that declares a proposal un-leasable produces an on-record default-denial", async () => {
  const home = await tempHome();
  try {
    const paths = resolveKeystonePaths(home);
    const projectId = newId("proj") as ProjectId;
    const denyAll: ActionCapabilityResolver = () => ({
      capability: undefined,
      resourceValues: [],
    });
    const session = await KernelSession.create({
      paths,
      projectId,
      request: "apply a fix",
      actorId: "test",
      proposeContract: stubProposer,
      resolveAction: denyAll,
    });
    await session.submit();
    await session.compile({
      profile: profileFor(projectId),
      autonomy: autonomyFor(projectId, ["src/**"]),
    });
    await session.start();

    const result = await session.authorize(proposalFor(session));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.denial.code, "resource_not_in_lease");
      assert.match(result.denial.detail, /not a leasable capability/);
    }
    const rejections = session.events().filter((event) => event.type === "action.rejected");
    assert.equal(rejections.length, 1, "the refusal must be on the record");
    const leases = session.events().filter((event) => event.type === "lease.issued");
    assert.equal(leases.length, 0, "no lease may be issued for a denied action");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the action resolver never changes folded or replayed state (resumed sessions are unaffected)", async () => {
  const { session, home } = await startTask();
  try {
    // Issue one lease while a resolver is wired.
    const granted = await session.authorize(proposalFor(session));
    assert.equal(granted.ok, true);
    const statusWithResolver = session.state().status;
    const seqWithResolver = session.state().seq;

    // Reopen the very same ledger with no resolver wired at all.
    const reopened = await KernelSession.open({
      paths: resolveKeystonePaths(home),
      taskId: session.taskId,
    });
    assert.equal(reopened.state().status, statusWithResolver);
    assert.equal(reopened.state().seq, seqWithResolver);
    assert.equal(reopened.replay().consistent, true);
    assert.ok(reopened.contract() !== undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("paused/stopped tasks and foreign proposals cannot obtain another lease", async () => {
  for (const kind of ["pause", "stop"] as const) {
    const { session, home } = await startTask();
    try {
      const foreign = proposalFor(session, { taskId: newId("task") });
      assert.equal((await session.authorize(foreign)).ok, false);
      const otherBranch = proposalFor(session, { branchId: newId("branch") });
      assert.equal((await session.authorize(otherBranch)).ok, false);
      await session[kind]("user control");
      assert.equal((await session.authorize(proposalFor(session))).ok, false);
      assert.equal(session.events().filter((event) => event.type === "lease.issued").length, 0);
      assert.equal(session.replay().consistent, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("a stale session cannot append over a newer committed chain tip", async () => {
  const { session, home } = await startTask();
  try {
    const second = await KernelSession.open({ paths: resolveKeystonePaths(home), taskId: session.taskId });
    await session.pause("first writer");
    await assert.rejects(() => second.stop("stale second writer"), /stale|tip|concurrent/i);
    const fresh = await KernelSession.open({ paths: resolveKeystonePaths(home), taskId: session.taskId });
    assert.equal(fresh.state().status, "paused");
    assert.equal(fresh.replay().consistent, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("standalone consent remains in the ledger without inventing an intervention in exported proof", async () => {
  const { session, home } = await startTask();
  try {
    const decision = userDecisionSchema.parse({
      decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: new Date().toISOString(),
      decision: "allow", rationale: "create a fresh local draft", recordedBy: "user",
      appliesTo: { capability: "fs.write", resources: ["src/**"] },
    });
    await session.recordUserDecision(decision);
    const state = session.state();
    const proof = await session.exportProof({ changedPaths: [] });
    assert.deepEqual(proof.interventions, []);
    assert.equal(proof.outcome, "not_proven");
    assert.deepEqual(session.state(), state, "proof projection must not change authoritative state");
    const interventionId = newId("intr");
    await session.recordUserDecision(userDecisionSchema.parse({ ...decision, decisionId: newId("dec"), interventionId }));
    const decided = await session.exportProof({ changedPaths: [] });
    assert.equal(decided.interventions.length, 1);
    assert.equal(decided.interventions[0]?.interventionId, interventionId);
    assert.equal(session.events().filter((event) => event.type === "intervention.decided").length, 2);
    assert.equal(session.replay().consistent, true);
    const reopened = await KernelSession.open({ paths: resolveKeystonePaths(home), taskId: session.taskId });
    assert.equal((await reopened.exportProof({ changedPaths: [] })).interventions.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("confirmed irreversible operations need a recorded decision bound to exact task and parameters", async () => {
  const { session, home } = await startTask();
  try {
    const parametersHash = contentHash({ command: "pnpm", args: ["test"] });
    const decision = userDecisionSchema.parse({
      decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: new Date().toISOString(),
      decision: "allow", rationale: "explicit human command", recordedBy: "user",
      appliesTo: { capability: "cmd.exec", resources: ["pnpm"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
      modifications: { parametersHash },
    });
    const input = {
      subject: { kind: "orchestrator" as const, id: "user.command" }, capability: "cmd.exec" as const,
      resourceValues: ["pnpm"], parametersHash, reversibility: "irreversible" as const, decision,
    };
    assert.equal((await session.authorizeOperation(input)).ok, false, "unrecorded decision cannot authorize");
    await session.recordUserDecision(decision);
    assert.equal((await session.authorizeOperation({ ...input, parametersHash: contentHash({ args: ["deploy"] }) })).ok, false);
    assert.equal((await session.authorizeOperation({ ...input, decision: userDecisionSchema.parse({ ...decision, taskId: newId("task") }) })).ok, false);
    assert.equal((await session.authorizeOperation(input)).ok, true);
    assert.equal(session.replay().consistent, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
