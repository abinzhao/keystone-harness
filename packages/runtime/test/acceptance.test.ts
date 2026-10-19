/**
 * End-to-end acceptance.
 *
 * This is the test that matters: it exercises PRD §14 (the first-run acceptance
 * loop) against a real Git repository, a real failing test, and a real file edit
 * — with a scripted model so the run is deterministic.
 *
 * What it proves, in order:
 *   1. A defect is fixed and the task reaches `proven` because tests actually
 *      passed, not because a model said so.
 *   2. The proof package is complete enough to review and reproduce.
 *   3. An out-of-scope write is refused *before* it touches the disk.
 *   4. A failing verification triggers a bounded repair that is allowed to succeed.
 *   5. The ledger replays to the same authoritative state after reopening.
 *   6. A workspace change invalidates the earlier proof.
 *   7. A model claiming it is finished never completes a task.
 *   8. A candidate experience never reaches a Context Plan.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { KernelSession, scanWorkspace } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { newId } from "@keystone/schemas";
import { KeystoneRuntime } from "../src/index.ts";
import {
  BUGGY_SESSION,
  FINISH_ACTION,
  FIXED_SESSION,
  WRONG_FIX_SESSION,
  autonomyFor,
  envelopeFor,
  fixtureTestsPass,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

test("a real defect is fixed and the task is proven by evidence, not by a claim", async () => {
  const fixture = await makeFixture();
  try {
    // Baseline: the defect is real.
    assert.equal(await fixtureTestsPass(fixture.root), false, "the fixture must start failing");

    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelopeFor([
              writeAction("src/auth/session.js", FIXED_SESSION),
            ]),
            envelopeFor([{ intent: "finish", tool: "fs.read_file", parameters: {}, rationale: "the fix is in place", expected_effects: [], requested_capabilities: [], produces_evidence_for: [], reversibility: "reversible" }]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request:
        "Fix the duplicate session refresh after expiry in src/auth/session.js and keep existing behaviour unchanged.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });

    assert.equal(result.status, "proven", `expected proven, got ${result.status}: ${result.reasons.join("; ")}`);
    assert.deepEqual(result.changedPaths, ["src/auth/session.js"]);
    assert.equal(await fixtureTestsPass(fixture.root), true, "the fixture's own tests must pass now");
    assert.equal(await readFile(join(fixture.root, "src", "auth", "session.js"), "utf8"), FIXED_SESSION);

    const proof = result.proof;
    assert.ok(proof !== undefined, "a proven task must produce a proof package");
    assert.equal(proof.outcome, "proven");
    assert.ok(proof.conditions.length >= 2, "the contract had at least two conditions");
    assert.ok(
      proof.conditions.filter((condition) => condition.required).every((condition) => condition.satisfied),
      "every required condition must be satisfied",
    );
    // Evidence must be real and traceable, not a model claim.
    assert.ok(proof.evidenceIndex.length > 0);
    assert.ok(
      proof.evidenceIndex.every((entry) => entry.level !== "E0"),
      "E0 (model claim) must never appear as supporting evidence",
    );
    assert.ok(proof.reproduceCommands.length > 0, "the proof must show how to reproduce the key check");
    assert.match(proof.summary, /proven/i);
    assert.deepEqual(proof.changes.changedPaths, ["src/auth/session.js"]);
    assert.equal(proof.changes.withinScope, true);
  } finally {
    await removeFixture(fixture);
  }
});

test("a write outside the declared scope is refused before it touches the disk", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelopeFor([writeAction("config/secrets.yaml", "leaked: true")]),
            envelopeFor([
              { intent: "finish", tool: "fs.read_file", parameters: {}, rationale: "done", expected_effects: [], requested_capabilities: [], produces_evidence_for: [], reversibility: "reversible" },
            ]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Write the deploy config into config/secrets.yaml.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 4,
    });

    assert.notEqual(result.status, "proven");
    // The refusal must be recorded, and the file must not exist.
    await assert.rejects(() => readFile(join(fixture.root, "config", "secrets.yaml"), "utf8"));

    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const rejections = session.events().filter((event) => event.type === "action.rejected");
    assert.ok(rejections.length > 0, "the refusal must be on the record");

    // The refusal should have asked the user rather than silently stopping.
    assert.ok(
      result.interventions.length > 0,
      "an out-of-scope request must surface as an intervention, not a silent failure",
    );
    assert.match(result.interventions[0]?.question ?? "", /outside what this task is allowed to touch|allow/i);
  } finally {
    await removeFixture(fixture);
  }
});


test("a failing verification triggers a bounded repair that is allowed to succeed", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            // Attempt 1: a plausible but wrong fix.
            envelopeFor([writeAction("src/auth/session.js", WRONG_FIX_SESSION)]),
            envelopeFor([FINISH_ACTION]),
            // Attempt 2, after being told the condition failed.
            envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
            envelopeFor([FINISH_ACTION]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      budget: { maxTokens: 200_000, maxWallClockMs: 600_000, maxRetries: 3 },
      acceptContractAutomatically: true,
      maxSteps: 6,
    });

    assert.equal(
      result.status,
      "proven",
      `the repair attempt should have fixed it: ${result.reasons.join("; ")}`,
    );
    assert.equal(await readFile(join(fixture.root, "src", "auth", "session.js"), "utf8"), FIXED_SESSION);

    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const repairEvents = session.events().filter((event) => event.type === "repair.produced_change");
    assert.ok(repairEvents.length >= 1, "the repair must be on the record, not silent");
    assert.ok(
      session.state().budgetUsed.retries >= 1,
      "the repair must consume retry budget so the limit is real",
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("the ledger replays to the same authoritative state after reopening", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
            envelopeFor([
              { intent: "finish", tool: "fs.read_file", parameters: {}, rationale: "done", expected_effects: [], requested_capabilities: [], produces_evidence_for: [], reversibility: "reversible" },
            ]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });

    const reopened = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    assert.equal(reopened.state().status, "proven");
    const replay = reopened.replay();
    assert.equal(replay.consistent, true, "replay must reproduce the authoritative status");
    assert.equal(replay.status, "proven");

    // The proof is a deterministic query: re-exporting gives the same verdict.
    const second = await reopened.exportProof({ changedPaths: ["src/auth/session.js"] });
    assert.equal(second.outcome, "proven");
    assert.equal(second.proofGraphHash, (await reopened.exportProof({ changedPaths: ["src/auth/session.js"] })).proofGraphHash);
  } finally {
    await removeFixture(fixture);
  }
});

test("a workspace change invalidates a previously proven task", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
            envelopeFor([
              { intent: "finish", tool: "fs.read_file", parameters: {}, rationale: "done", expected_effects: [], requested_capabilities: [], produces_evidence_for: [], reversibility: "reversible" },
            ]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });
    assert.equal(result.status, "proven");

    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const before = await scanWorkspace(fixture.root);

    // Someone edits the file outside Keystone.
    await writeFile(join(fixture.root, "src", "auth", "session.js"), `${BUGGY_SESSION}// external edit\n`);
    const after = await scanWorkspace(fixture.root);

    const invalidated = await session.invalidateStaleEvidence({
      previousFingerprint: before.fingerprint,
      currentFingerprint: after.fingerprint,
      changedPaths: ["src/auth/session.js"],
    });
    assert.ok(invalidated.length > 0, "evidence about the old workspace must be invalidated");

    // The historical verdict is preserved, but the current proof is not valid.
    const reEvaluated = await session.evaluateProof({
      changedPaths: ["src/auth/session.js"],
      workspaceFingerprint: after.fingerprint,
    });
    assert.equal(reEvaluated.decision.outcome, "not_proven");
  } finally {
    await removeFixture(fixture);
  }
});

test("a model that claims the work is done does not make the task proven", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelopeFor([
              {
                intent: "finish",
                tool: "fs.read_file",
                parameters: {},
                rationale: "the code already looks correct, nothing to change",
                expected_effects: [],
                requested_capabilities: [],
                produces_evidence_for: [],
                reversibility: "reversible",
              },
            ]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });

    // The defect is still present, so no amount of model confidence may produce
    // a proven task (PRD 9.1).
    assert.notEqual(result.status, "proven", "a model claim must never complete a task");
    assert.equal(await fixtureTestsPass(fixture.root), false, "the defect is still present");
    assert.ok(result.reasons.length > 0, "the task must explain why it is not proven");
    assert.equal(result.proof?.outcome, "not_proven");
    assert.ok(
      (result.proof?.conditions ?? []).some(
        (condition) => condition.required && !condition.satisfied,
      ),
      "the failing condition must be visible in the proof",
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("a candidate experience stays quarantined and is never used as context", async () => {
  const fixture = await makeFixture();
  try {
    const { ExperienceFirewall } = await import("@keystone/kernel");
    const projectId = `proj_${"0".repeat(26)}`;
    const firewall = new ExperienceFirewall(fixture.paths, projectId);
    await firewall.load();

    const candidate = await firewall.proposeCandidate({
      projectId,
      sourceTaskIds: [newId("task")],
      category: "localization_path",
      statement: "session refresh lives in src/auth/session.js",
      applicability: { paths: ["src/auth"], symbols: [], languages: ["javascript"], packageManagers: ["npm"], toolVersions: [], taskShapes: ["bugfix"] },
      provenance: {
        provenanceId: newId("prov") as never,
        sourceKind: "model",
        trustLevel: "observed",
        locator: "step.localize",
        derivedFrom: [],
        invalidatedBy: [],
        observedAt: new Date().toISOString() as never,
      },
      supportingEvidenceIds: [newId("evd")],
      note: "observed once",
    });

    assert.equal(candidate.status, "quarantined");
    const verdict = firewall.evaluatePromotion(candidate);
    assert.equal(verdict.eligible, false, "one observation is not knowledge");
    assert.deepEqual(firewall.promoted(), []);
    assert.deepEqual(
      firewall.selectForContext({ taskShape: "bugfix", paths: ["src/auth"] }),
      [],
      "a quarantined candidate must never reach a Context Plan",
    );
  } finally {
    await removeFixture(fixture);
  }
});
