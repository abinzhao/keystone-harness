/**
 * Risk-graded startup decisions (ADR-0013).
 *
 * These pin down that the grade is a pure function of its inputs and that the
 * safety reasons are derived server-side: the user toggle and the project
 * policy only tighten, and a dirty overlap refuses rather than merely asking.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { autonomyEnvelopeSchema, newId, type AutonomyEnvelope, type OutcomeContract } from "@keystone/schemas";

import {
  DEFAULT_START_POLICY,
  findDirtyOverlap,
  gradeStartRisk,
} from "../src/start-risk.ts";

/** A minimal contract the grader reads; only the fields it touches matter. */
function makeContract(overrides: Partial<{
  status: OutcomeContract["status"];
  unknown: string[];
  writeInclude: { kind: "path" | "directory" | "glob"; pattern: string; intent: "write" }[];
  openUncertainty: boolean;
}> = {}): OutcomeContract {
  return {
    status: overrides.status ?? "ready",
    scope: {
      include: overrides.writeInclude ?? [{ kind: "directory", pattern: "src", intent: "write" }],
      exclude: [],
      unknown: overrides.unknown ?? [],
    },
    uncertainties: overrides.openUncertainty
      ? [{ uncertaintyId: "u1", question: "?", affects: "scope", resolution: "open" }]
      : [],
  } as unknown as OutcomeContract;
}

function envelope(overrides: Partial<{
  maxReversibility: AutonomyEnvelope["maxReversibility"];
  externalSystems: AutonomyEnvelope["externalSystems"];
  allowedHosts: string[];
  allowedCommands: string[];
}> = {}): AutonomyEnvelope {
  return autonomyEnvelopeSchema.parse({
    projectId: newId("proj"),
    readPaths: ["**"],
    writePaths: ["src/**"],
    allowedCommands: overrides.allowedCommands ?? ["node", "npm"],
    allowedHosts: overrides.allowedHosts ?? [],
    allowedCredentials: [],
    externalSystems: overrides.externalSystems ?? "none",
    maxReversibility: overrides.maxReversibility ?? "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 100_000, maxWallClockMs: 600_000, maxRetries: 3 },
    updatedAt: new Date().toISOString(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

test("a clean, narrow, reversible, in-scope write auto-starts", () => {
  const result = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.equal(result.decision, "auto_start");
  assert.deepEqual(result.reasons, []);
});

test("open questions, an approval-blocked contract or open uncertainty all force confirmation", () => {
  const withQuestions = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [{ questionId: "q1", affects: "scope" }],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.equal(withQuestions.decision, "require_confirmation");
  assert.ok(withQuestions.reasons.includes("ambiguity"));

  const blocked = gradeStartRisk({
    contract: makeContract({ status: "awaiting_approval" }),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(blocked.reasons.includes("ambiguity"));

  const uncertain = gradeStartRisk({
    contract: makeContract({ openUncertainty: true }),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(uncertain.reasons.includes("ambiguity"));
});

test("unresolved scope or a write scope beyond the named paths forces confirmation", () => {
  const unknown = gradeStartRisk({
    contract: makeContract({ unknown: ["修改范围未确定：整个仓库"] }),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(unknown.reasons.includes("scope_expansion"));

  // The compiler inferred a second directory the user never named.
  const wider = gradeStartRisk({
    contract: makeContract({
      writeInclude: [
        { kind: "directory", pattern: "src", intent: "write" },
        { kind: "directory", pattern: "packages", intent: "write" },
      ],
    }),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(wider.reasons.includes("scope_expansion"));
});

test("a widened envelope (non-reversible or external) forces confirmation", () => {
  const irreversible = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope({ maxReversibility: "compensable" }),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(irreversible.reasons.includes("irreversible"));

  const external = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope({ allowedHosts: ["api.github.com"] }),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(external.reasons.includes("external_action"));

  const writeOut = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope({ externalSystems: "reversible_write" }),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(writeOut.reasons.includes("external_action"));
});

test("destructive commands or an unbounded root scope are high risk", () => {
  const destructive = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope({ allowedCommands: ["node", "git push --force"] }),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(destructive.reasons.includes("high_risk"));

  const root = gradeStartRisk({
    contract: makeContract({
      writeInclude: [{ kind: "glob", pattern: "**", intent: "write" }],
    }),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["**"],
    dirtyOverlap: [],
    policy: DEFAULT_START_POLICY,
  });
  assert.ok(root.reasons.includes("high_risk"));
});

test("the user toggle and the project policy both tighten to confirmation; neither can loosen auto-start", () => {
  const userToggle = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: { ...DEFAULT_START_POLICY, confirmAllWrites: true },
  });
  assert.equal(userToggle.decision, "require_confirmation");
  assert.ok(userToggle.reasons.includes("policy_required"));

  const projectPolicy = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: { ...DEFAULT_START_POLICY, projectConfirmAllWrites: true },
  });
  assert.ok(projectPolicy.reasons.includes("policy_required"));

  // A project that disables auto-start still confirms even a clean task.
  const noAuto = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: [],
    policy: { ...DEFAULT_START_POLICY, allowAutoStartForLowRisk: false },
  });
  assert.equal(noAuto.decision, "require_confirmation");
  assert.deepEqual(noAuto.reasons, ["policy_required"]);
});

test("dirty worktree overlap refuses and carries a recovery path", () => {
  const result = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [],
    userWritePaths: ["src/**"],
    dirtyOverlap: ["src/auth/session.js", "src/util.ts"],
    policy: DEFAULT_START_POLICY,
  });
  assert.equal(result.decision, "refuse");
  assert.deepEqual(result.reasons, ["dirty_overlap"]);
  assert.match(result.recovery ?? "", /commit or stash/i);
  assert.match(result.recovery ?? "", /isolated mode/i);
  // Refusal outranks a safety reason: even with confirmAllWrites on, a dirty
  // overlap is a refusal, not a confirmation.
  const alsoRefused = gradeStartRisk({
    contract: makeContract(),
    envelope: envelope(),
    questions: [{ questionId: "q", affects: "scope" }],
    userWritePaths: ["src/**"],
    dirtyOverlap: ["src/auth/session.js"],
    policy: { ...DEFAULT_START_POLICY, confirmAllWrites: true },
  });
  assert.equal(alsoRefused.decision, "refuse");
  assert.deepEqual(alsoRefused.reasons, ["dirty_overlap"]);
});

test("findDirtyOverlap matches paths, directories and globs", () => {
  assert.deepEqual(findDirtyOverlap(["src/auth/session.js"], ["src/**"]), ["src/auth/session.js"]);
  assert.deepEqual(findDirtyOverlap(["src/auth/session.js"], ["src"]), ["src/auth/session.js"]);
  assert.deepEqual(findDirtyOverlap(["README.md"], ["src/**"]), []);
  // Untracked files count as dirty and overlap a directory write.
  assert.deepEqual(findDirtyOverlap(["src/new_file.ts"], ["src"]), ["src/new_file.ts"]);
});
