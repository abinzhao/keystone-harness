/**
 * Localization placeholder-parity end to end — the *second* scenario pack.
 *
 * This is the non-engineering reference scenario, run the way a user would run
 * it: a real offline Git repository whose translation must keep every source
 * placeholder. Crucially, "done" here is proven **by the extension pack, not by
 * the engineering harness**:
 *
 *   - the runtime is handed a localization-specific `ContractProposer`
 *     (`compileLocalizationContract`) whose single required condition names the
 *     extension's own E2 verifier **by explicit id** — not the engineering
 *     `verifier.test`;
 *   - the runtime is handed that extension verifier (`localizationParityE2Verifier`),
 *     which runs the deterministic parity checker in a **child process**.
 *
 * No kernel or schema change is involved: the whole second vertical is the
 * injected proposer + injected verifier. The fixture's own `npm test` parity
 * check is used only as an *independent oracle* at the edges — it is not the
 * producer of the proof.
 *
 * What it proves, in order:
 *   1. The baseline is genuinely broken (the parity check fails), and a
 *      translation that preserves the placeholders reaches `proven` on E2
 *      evidence produced by the extension verifier — not on a model's say-so and
 *      not on the engineering test verifier.
 *   2. A model that merely claims it is finished never reaches `proven`.
 *   3. A bounded repair may succeed: a plausible-but-still-wrong translation
 *      fails the extension check, then a corrected one passes.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  compileLocalizationContract,
  localizationParityE2Verifier,
} from "@keystone/extension-localization-placeholders";
import { KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";

import { KeystoneRuntime } from "../src/index.ts";
import { autonomyFor } from "./fixture.ts";
import {
  BROKEN_ZH_CATALOG,
  FINISH,
  FIXED_ZH_CATALOG,
  WRONG_ZH_CATALOG,
  localizationTestsPass,
  makeLocalizationFixture,
  removeLocalizationFixture,
  writeCatalogAction,
} from "./localization-fixture.ts";

const E2_VERIFIER_ID = localizationParityE2Verifier.descriptor.id;

function envelope(actions: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ summary: "scripted plan", actions: [...actions] });
}

test("a parity-preserving translation reaches proven on extension E2 evidence", async () => {
  const fixture = await makeLocalizationFixture();
  try {
    // Baseline: the shipped translation drops a placeholder, so the check fails.
    assert.equal(
      await localizationTestsPass(fixture.root),
      false,
      "the fixture must start with a failing parity test",
    );

    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      contractProposer: compileLocalizationContract,
      verifiers: [localizationParityE2Verifier],
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelope([writeCatalogAction("locales/zh.json", FIXED_ZH_CATALOG)]),
            envelope([FINISH]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request:
        "Update the Chinese translation in locales/zh.json so every placeholder the English source uses is preserved.",
      references: [{ kind: "directory", value: "locales" }],
      autonomy: autonomyFor(["locales/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });

    assert.equal(
      result.status,
      "proven",
      `expected proven, got ${result.status}: ${result.reasons.join("; ")}`,
    );
    assert.deepEqual(result.changedPaths, ["locales/zh.json"]);
    assert.equal(await localizationTestsPass(fixture.root), true, "the parity test must pass now");
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.root, "locales", "zh.json"), "utf8")),
      FIXED_ZH_CATALOG,
    );

    // The contract must be the localization one: its only required condition names
    // the extension E2 verifier, and it must NOT contain the engineering test check.
    const conditions = result.contract.completionConditions;
    assert.equal(conditions.length, 1, "the localization contract has exactly one completion condition");
    const onlyCondition = conditions[0];
    assert.ok(onlyCondition !== undefined);
    assert.equal(onlyCondition.required, true);
    assert.equal(
      onlyCondition.verifier.id,
      E2_VERIFIER_ID,
      "the required condition must target the extension E2 verifier by id",
    );
    assert.ok(
      conditions.every((c) => c.verifier.id !== "verifier.test"),
      "no engineering `test` condition may appear in a localization proof",
    );

    // Proof must rest on real E2 evidence produced by the extension verifier.
    const proof = result.proof;
    assert.ok(proof !== undefined, "a proven task must produce a proof package");
    assert.equal(proof.outcome, "proven");
    assert.ok(proof.evidenceIndex.length > 0, "there must be evidence behind the proof");
    assert.ok(
      proof.evidenceIndex.every((entry) => entry.level !== "E0"),
      "E0 (model claim) must never appear as supporting evidence",
    );
    for (const entry of proof.evidenceIndex) {
      assert.equal(entry.producerId, E2_VERIFIER_ID, "evidence must be produced by the extension verifier");
      assert.equal(entry.level, "E2", "the proof rests on controlled-execution (E2) evidence");
      assert.equal(entry.independenceMode, "separate_process", "the E2 run is a separate child process");
    }
    const parity = proof.conditions.find((c) => c.conditionId === "cond.placeholder_parity");
    assert.ok(parity !== undefined, "the parity condition must appear in the proof");
    assert.equal(parity.required, true);
    assert.equal(parity.satisfied, true);
    assert.equal(parity.achievedLevel, "E2");
    assert.ok(
      proof.conditions.filter((c) => c.required).every((c) => c.satisfied),
      "every required condition must be satisfied",
    );
  } finally {
    await removeLocalizationFixture(fixture);
  }
});

test("a model that claims the translation is done does not reach proven", async () => {
  const fixture = await makeLocalizationFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      contractProposer: compileLocalizationContract,
      verifiers: [localizationParityE2Verifier],
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            envelope([
              {
                intent: "finish",
                tool: "fs.read_file",
                parameters: {},
                rationale: "the translation already looks fine, nothing to change",
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
      request: "Fix the Chinese translation in locales/zh.json.",
      references: [{ kind: "directory", value: "locales" }],
      autonomy: autonomyFor(["locales/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });

    // The dropped placeholder is still on disk, so the extension E2 check fails
    // and no amount of model confidence can produce a proven task (PRD 9.1).
    assert.notEqual(result.status, "proven", "a model claim must never complete the task");
    assert.equal(await localizationTestsPass(fixture.root), false, "the dropped placeholder is still present");
    assert.ok(result.reasons.length > 0, "the task must explain why it is not proven");
    assert.equal(result.proof?.outcome, "not_proven");
    const parityResult = result.proof?.conditions.find((c) => c.conditionId === "cond.placeholder_parity");
    assert.ok(parityResult !== undefined && parityResult.required && !parityResult.satisfied);
    // No E2 evidence was accepted for the still-broken catalog.
    assert.equal(
      result.proof?.evidenceIndex.filter((e) => e.level === "E2" && e.status === "valid").length ?? 0,
      0,
      "a failing check must not leave valid E2 evidence behind",
    );

    // The broken catalog from the baseline commit is untouched.
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.root, "locales", "zh.json"), "utf8")),
      BROKEN_ZH_CATALOG,
    );
  } finally {
    await removeLocalizationFixture(fixture);
  }
});

test("a bounded repair may succeed after a still-broken first attempt", async () => {
  const fixture = await makeLocalizationFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      contractProposer: compileLocalizationContract,
      verifiers: [localizationParityE2Verifier],
      models: [
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          responses: [
            // Attempt 1: reads better, but still drops {count}.
            envelope([writeCatalogAction("locales/zh.json", WRONG_ZH_CATALOG)]),
            envelope([FINISH]),
            // Attempt 2, after being told the parity condition failed.
            envelope([writeCatalogAction("locales/zh.json", FIXED_ZH_CATALOG)]),
            envelope([FINISH]),
          ],
        }),
      ],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the Chinese translation in locales/zh.json.",
      references: [{ kind: "directory", value: "locales" }],
      autonomy: autonomyFor(["locales/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });

    assert.equal(
      result.status,
      "proven",
      `the repair should have fixed parity: ${result.reasons.join("; ")}`,
    );
    assert.equal(await localizationTestsPass(fixture.root), true);
    // The proof for the successful repair is the extension verifier's E2 run.
    assert.ok(
      result.proof?.evidenceIndex.some((e) => e.producerId === E2_VERIFIER_ID && e.level === "E2"),
      "the proven repair must be backed by the extension E2 verifier",
    );

    // The repair is on the record and consumed retry budget, so the bound is real.
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const repairEvents = session.events().filter((e) => e.type === "repair.produced_change");
    assert.ok(repairEvents.length >= 1, "the repair must be recorded, not silent");
    assert.ok(session.state().budgetUsed.retries >= 1, "a repair attempt must consume retry budget");
  } finally {
    await removeLocalizationFixture(fixture);
  }
});
