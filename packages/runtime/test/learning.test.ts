/**
 * Learning cycle (PRD 8.7).
 *
 * The promise being tested is narrow and easy to get wrong in the flattering
 * direction: "keeps getting better" has to mean *provably* better, and a lesson
 * that stops working has to leave before it is used again.
 *
 * These tests run the same fixture twice. The first run teaches; the second run
 * is judged, and a failed reuse demotes what it used.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ExperienceFirewall, KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor, createScriptedAdapter } from "@keystone/models";
import { KeystoneRuntime } from "../src/index.ts";
import {
  FINISH_ACTION,
  FIXED_SESSION,
  WRONG_FIX_SESSION,
  autonomyFor,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

function builderFor(responses: readonly string[]) {
  return createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "builder" }),
    responses,
  });
}

test("a proven run promotes what it can prove and quarantines what it merely observed", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        builderFor([
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ]),
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

    // The change set that made the checks pass is a deterministic tool result,
    // so one run is enough to promote it.
    assert.equal(result.learning.promoted.length, 1, JSON.stringify(result.learning.promoted));
    assert.match(result.learning.promoted[0]?.statement ?? "", /changing src\/auth\/session\.js/);

    // Which files *looked* relevant is a model-shaped inference, so it stays a
    // candidate. It must be recorded -- and it must not be promoted.
    assert.equal(result.learning.candidates.length, 2);
    assert.ok(
      result.learning.skipped.some((entry) => /src\/auth/.test(entry.statement)),
      "the localization inference must be reported as skipped",
    );
    assert.ok(
      result.learning.skipped.every((entry) => entry.reason.length > 0),
      "a skip without a reason is not an explanation",
    );

    // The ledger must carry the lifecycle, not just the store.
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const types = session.events().map((event) => event.type);
    assert.ok(types.includes("experience.candidate_created"));
    assert.ok(types.includes("experience.promoted"));

    // A second run of the *same* project must be able to read the promoted entry.
    const firewall = new ExperienceFirewall(fixture.paths, result.contract.projectId);
    await firewall.load();
    assert.equal(firewall.promoted().length, 1);
    assert.equal(firewall.candidates().length, 2);
  } finally {
    await removeFixture(fixture);
  }
});

test("a promoted entry is offered to the next task, and a failed reuse demotes it", async () => {
  const fixture = await makeFixture();
  try {
    const first = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        builderFor([
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ]),
      ],
    });

    const learned = await first.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 6,
    });
    assert.equal(learned.status, "proven");
    assert.equal(learned.learning.promoted.length, 1);
    const entryId = learned.learning.promoted[0]?.entryId;
    assert.ok(entryId !== undefined);

    // Second task: the model keeps writing a fix that does not work. The entry
    // from the first run is in context, its scope gets modified, and the task
    // does not prove out.
    const second = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [
        createScriptedAdapter({
          descriptor: scriptedModelDescriptor({ id: "builder" }),
          respond: (_request, callIndex) =>
            callIndex % 2 === 0
              ? envelopeFor([writeAction("src/auth/session.js", WRONG_FIX_SESSION)])
              : envelopeFor([FINISH_ACTION]),
        }),
      ],
    });

    const reused = await second.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh again in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
      budget: { maxTokens: 200_000, maxWallClockMs: 600_000, maxRetries: 2 },
    });

    assert.notEqual(reused.status, "proven");

    // 1. The entry was actually offered to this run, with a stated reason.
    assert.equal(reused.learning.usedEntries.length, 1, JSON.stringify(reused.learning.usedEntries));
    assert.equal(reused.learning.usedEntries[0]?.entryId, entryId);
    assert.ok((reused.learning.usedEntries[0]?.reason ?? "").length > 0);

    // 2. Its use was judged from this run's evidence, as a negative transfer.
    const judgement = reused.learning.evaluations.find((entry) => entry.entryId === entryId);
    assert.ok(judgement !== undefined, "the run must judge the experience it was given");
    assert.equal(judgement.outcome, "negative_transfer");

    // 3. A negative transfer demotes immediately: the next task must not get it.
    assert.deepEqual(
      reused.learning.demoted.map((entry) => entry.entryId),
      [entryId],
    );

    const firewall = new ExperienceFirewall(fixture.paths, reused.contract.projectId);
    await firewall.load();
    assert.deepEqual(firewall.promoted(), [], "a demoted entry must leave the reusable set");
    assert.deepEqual(firewall.selectForContext({ taskShape: "bugfix", paths: ["src"] }), []);

    // 4. Both the judgement and the demotion are on the record.
    const session = await KernelSession.open({ paths: fixture.paths, taskId: reused.taskId });
    const types = session.events().map((event) => event.type);
    assert.ok(types.includes("experience.evaluated"), "the evaluation must be recorded");
    assert.ok(types.includes("experience.demoted"), "the demotion must be recorded");
    const demotion = session.events().find((event) => event.type === "experience.demoted");
    assert.equal(demotion?.payload["entryId"], entryId);
    assert.equal(demotion?.payload["reason"], "caused_verification_failure");
  } finally {
    await removeFixture(fixture);
  }
});

test("an unproven run teaches nothing, so it cannot poison the next task", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [builderFor([envelopeFor([FINISH_ACTION])])],
    });

    const result = await runtime.runTask({
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });

    assert.notEqual(result.status, "proven");
    assert.deepEqual(result.learning.candidates, []);
    assert.deepEqual(result.learning.promoted, []);
    assert.ok(
      result.learning.skipped.some((entry) => /not proven/.test(entry.reason)),
      "the run must say why it taught nothing",
    );

    const firewall = new ExperienceFirewall(fixture.paths, result.contract.projectId);
    await firewall.load();
    assert.deepEqual(firewall.candidates(), []);
    assert.deepEqual(firewall.promoted(), []);
  } finally {
    await removeFixture(fixture);
  }
});
