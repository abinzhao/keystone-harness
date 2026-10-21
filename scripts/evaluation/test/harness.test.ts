import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { EVALUATION_SUITE, evaluationFingerprint, runEvaluation } from "../harness.ts";

test("versioned inputs fingerprint deterministically and reject non-repeated evaluation", async () => {
  assert.equal(EVALUATION_SUITE.version, "keystone.evaluation/1");
  assert.equal(evaluationFingerprint(), evaluationFingerprint());
  assert.match(evaluationFingerprint(), /^[0-9a-f]{64}$/);
  await assert.rejects(runEvaluation({ repetitions: 1 }), /repetitions/);
});

test("repeated minimal/standard scorecard observes independent checks, limits and replay", { timeout: 180_000 }, async () => {
  const removed: string[] = [];
  const card = await runEvaluation({ repetitions: 2, onTemporaryRoot: (root) => {
    assert.equal(isAbsolute(root), true);
    assert.equal(root.includes("/keystone-harness/"), false);
    removed.push(root);
  } });
  assert.equal(card.version, EVALUATION_SUITE.version);
  assert.equal(card.inputFingerprint, evaluationFingerprint());
  assert.equal(card.runs.length, EVALUATION_SUITE.fixtures.length * 4);
  assert.equal(card.adapter.modelName, "scripted-1");
  assert.equal(card.adapter.network, false);
  assert.equal(card.metrics.falseCompletions, 0);
  assert.equal(card.metrics.scopeEscapes, 0);
  assert.equal(card.metrics.replayInconsistent, 0);
  assert.ok(card.missingMetrics.some((item) => item.id === "live_provider_quality"));
  assert.ok(card.missingMetrics.some((item) => item.id === "crash_recovery"));
  for (const run of card.runs) {
    assert.equal(run.baselineAccepted, false);
    assert.equal(run.acceptanceProtected, true);
    assert.equal(run.scopeEscaped, false);
    assert.equal(run.replayConsistent, true);
    assert.equal(run.budget.used.tokens, 0, "scripted adapter reports zero measured tokens");
    assert.ok(run.budget.used.wallClockMs >= 0);
    if (run.mode === "minimal") {
      assert.equal(run.modelCalls, 0);
      assert.equal(run.completed, false);
      assert.equal(run.acceptancePassed, false);
    }
    if (run.mode === "standard" && ["correct_repair", "bounded_repair", "checkpoint_continuation"].includes(run.fixtureId)) {
      assert.equal(run.completed, true, JSON.stringify(run));
      assert.equal(run.acceptancePassed, true);
      assert.equal(run.kernelStatus, "proven");
    }
    if (run.mode === "standard" && run.fixtureId === "scope_escape") {
      assert.ok(run.rejectedActions > 0);
      assert.equal(run.failureClass, "scope_refused");
    }
    if (run.mode === "standard" && run.fixtureId === "claim_only") {
      assert.equal(run.completed, false);
      assert.equal(run.failureClass, "verification_failed");
    }
    if (run.mode === "standard" && run.fixtureId === "budget_exhaustion") {
      assert.equal(run.modelCalls, 0);
      assert.equal(run.failureClass, "budget_exhausted");
    }
    if (run.mode === "standard" && run.fixtureId === "checkpoint_continuation") {
      assert.equal(run.recovery.status, "passed");
      assert.equal(run.recovery.executedWrites, 1);
    }
    if (run.mode === "standard" && run.fixtureId === "bounded_repair") assert.ok(run.budget.used.retries >= 1);
  }
  assert.equal(removed.length, card.runs.length);
  for (const root of removed) await assert.rejects(access(root), { code: "ENOENT" });
});
