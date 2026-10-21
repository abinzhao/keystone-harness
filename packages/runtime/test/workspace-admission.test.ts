/**
 * Workspace single-writer admission.
 *
 * Determinism matters here: the overlap tests gate the first run *inside* its
 * model call, then drive the second run against a resolved signal. No sleep is
 * used — the second run is started only after the first has already reported that
 * it holds the lock and is waiting, so the interleaving is exact.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { scriptedModelDescriptor, type ModelAdapter } from "@keystone/models";

import {
  KeystoneRuntime,
  WorkspaceBusyError,
  WorkspaceWriteAdmission,
  type RunTaskResult,
} from "../src/index.ts";
import { autonomyFor, envelopeFor, FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

const FINISH_ENVELOPE = envelopeFor([FINISH_ACTION]);

/** A builder adapter that reports entry on the first call, then waits on `gate`. */
function gatedBuilder(onEnter: () => void, gate: Promise<void>): ModelAdapter {
  const descriptor = scriptedModelDescriptor({ id: "gated-builder" });
  return {
    descriptor,
    async complete() {
      onEnter();
      await gate;
      return {
        text: FINISH_ENVELOPE,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        modelName: descriptor.modelName,
        finishReason: "stop",
      };
    },
  };
}

test("the admission lock is exclusive per workspace and releases idempotently", () => {
  const admission = new WorkspaceWriteAdmission();
  const releaseA = admission.tryAcquire("proj_alpha", "2026-10-20T00:00:00.000Z");
  assert.equal(admission.isHeld("proj_alpha"), true);

  // A second writer on the same workspace is refused and directed to isolation.
  assert.throws(
    () => admission.tryAcquire("proj_alpha", "2026-10-20T00:00:01.000Z"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBusyError);
      assert.match(error.message, /isolated mode/);
      return true;
    },
  );

  // A different workspace is not blocked by this holder.
  const releaseB = admission.tryAcquire("proj_beta", "2026-10-20T00:00:02.000Z");
  assert.equal(admission.isHeld("proj_beta"), true);

  // Naming the holder is how a later refusal names the running task.
  admission.noteHolder("proj_alpha", "task_holder");
  assert.throws(
    () => admission.tryAcquire("proj_alpha", "2026-10-20T00:00:03.000Z"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBusyError);
      assert.equal(error.holderTaskId, "task_holder");
      return true;
    },
  );

  // Release frees the workspace; double release is a no-op (finally-safe).
  releaseA();
  releaseA();
  assert.equal(admission.isHeld("proj_alpha"), false);
  const releaseAgain = admission.tryAcquire("proj_alpha", "2026-10-20T00:00:04.000Z");
  releaseB();
  releaseAgain();
  assert.equal(admission.isHeld("proj_alpha"), false);
  assert.equal(admission.isHeld("proj_beta"), false);
});

test("a second standard run on the same workspace is refused, then admitted after the first finishes", async () => {
  const fixture = await makeFixture();
  try {
    let releaseGate!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [gatedBuilder(entered, gate)],
    });

    const first = runtime.runTask({
      workspacePath: fixture.root,
      request: "Apply the one-line fix and stop.",
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });

    // The first run has taken the lock and is now waiting inside its model call.
    await enteredPromise;

    // A second standard run on the SAME workspace is refused at admission —
    // before it attaches the project or creates a task — and told to isolate.
    await assert.rejects(
      () =>
        runtime.runTask({
          workspacePath: fixture.root,
          request: "A different change to the same working copy.",
          autonomy: autonomyFor(["src/**"]),
          acceptContractAutomatically: true,
          maxSteps: 3,
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceBusyError);
        assert.match(error.message, /isolated mode/);
        return true;
      },
    );

    // Let the first run finish; the lock must release on completion.
    releaseGate();
    const done: RunTaskResult = await first;
    assert.ok(done.taskId.length > 0);

    // The workspace is free again: a third run proceeds instead of being refused.
    const third = await runtime.runTask({
      workspacePath: fixture.root,
      request: "One more change now the workspace is free.",
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });
    assert.ok(third.taskId.length > 0, "the workspace must be writable again after the first run ended");
  } finally {
    await removeFixture(fixture);
  }
});

test("an isolated run is not blocked by a standard run holding the workspace lock", async () => {
  const fixture = await makeFixture();
  try {
    let releaseGate!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const standard = await KeystoneRuntime.create({
      paths: fixture.paths,
      models: [gatedBuilder(entered, gate)],
    });

    const first = standard.runTask({
      workspacePath: fixture.root,
      request: "Hold the workspace lock.",
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });
    await enteredPromise;

    // Isolated mode works in a throwaway worktree, so it must proceed even while
    // the standard run holds the lock on the shared working copy.
    const isolated = await KeystoneRuntime.create({
      paths: fixture.paths,
      mode: "isolated",
      models: [gatedBuilder(() => undefined, Promise.resolve())],
    });
    const isoResult = await isolated.runTask({
      workspacePath: fixture.root,
      request: "Work on a copy instead.",
      autonomy: autonomyFor(["src/**"]),
      acceptContractAutomatically: true,
      maxSteps: 3,
    });
    assert.ok(isoResult.isolatedWorkspace !== undefined, "isolated mode must report its worktree");

    releaseGate();
    await first;
  } finally {
    await removeFixture(fixture);
  }
});
