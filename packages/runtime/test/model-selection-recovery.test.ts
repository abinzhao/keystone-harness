import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { getArtifactBytes, KernelSession } from "@keystone/kernel";
import {
  createSequenceAdapter, defaultConfig, loadConfigSnapshot, saveConfigSnapshot, scriptedModelDescriptor,
  type ModelAdapter, type ModelConfigEntry,
} from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import {
  autonomyFor, envelopeFor, FINISH_ACTION, FIXED_SESSION, makeFixture, removeFixture, writeAction,
} from "./fixture.ts";

const defaultRoutes = { builder: ["default"], planner: ["default"], summarizer: ["default"] };
const configurationSnapshot = {
  revision: "selected-model-revision", modelIds: ["default", "default", "default"], builderModelId: "selected",
};

function models(responses: readonly string[]) {
  const fallback = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "default" }), responses: ["unused default response"],
  });
  const selected = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "selected" }),
    responses: responses.length > 0 ? responses : ["unused selected response"],
  });
  return { fallback, selected, adapters: [fallback, selected] };
}

test("selected non-default model resumes with the original task routes after restart", async () => {
  const fixture = await makeFixture();
  try {
    const initial = models([envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)])]);
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes: defaultRoutes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "fix src/auth/session.js", modelId: "selected",
      references: [{ kind: "file", value: "src/auth/session.js" }],
      configurationSnapshot, autonomy: autonomyFor(["src/auth/**"]), acceptContractAutomatically: true,
      control: async () => (await readFile(join(fixture.root, "src/auth/session.js"), "utf8")) === FIXED_SESSION
        ? { kind: "pause", reason: "restart selected model" } : undefined,
    });
    assert.equal(paused.status, "paused");
    assert.equal(initial.selected.callCount(), 1);
    assert.equal(initial.fallback.callCount(), 0);
    const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    const originalContract = before.contract();
    const continuation = models([envelopeFor([FINISH_ACTION])]);
    const restarted = await KeystoneRuntime.create({
      paths: fixture.paths, models: continuation.adapters, routes: defaultRoutes,
    });
    const resumed = await restarted.resumeTask(paused.taskId);
    assert.equal(resumed.taskId, paused.taskId);
    assert.equal(resumed.status, "proven", JSON.stringify(resumed.reasons));
    assert.deepEqual(resumed.changedPaths, ["src/auth/session.js"]);
    assert.equal(continuation.selected.callCount(), 1);
    assert.equal(continuation.fallback.callCount(), 0);
    assert.deepEqual(restarted.describeEgress().map(entry => entry.modelId), ["default", "default", "default"]);
    const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.deepEqual(after.contract(), originalContract);
    assert.deepEqual(after.events().find(event => event.type === "task.created")?.payload["configurationSnapshot"],
      configurationSnapshot);
    assert.ok(after.events().some(event => event.type === "recovery.verified"));
    assert.deepEqual(after.events().filter(event => event.type === "model.response_recorded")
      .map(event => event.payload["modelId"]), ["selected", "selected"]);
  } finally { await removeFixture(fixture); }
});

test("direct selected-model runs persist enough routing context to resume", async () => {
  const fixture = await makeFixture();
  try {
    const initial = models([]);
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes: defaultRoutes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
      autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "pause before invocation" }),
    });
    assert.equal(paused.status, "paused");
    const continuation = models([envelopeFor([FINISH_ACTION])]);
    const restarted = await KeystoneRuntime.create({
      paths: fixture.paths, models: continuation.adapters, routes: defaultRoutes,
    });
    const resumed = await restarted.resumeTask(paused.taskId);
    assert.equal(resumed.status, "exited_gracefully");
    assert.equal(continuation.selected.callCount(), 1);
    assert.equal(continuation.fallback.callCount(), 0);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    const checkpoint = await session.latestCheckpoint();
    assert.ok(checkpoint);
    const artifacts = await Promise.all(checkpoint.artifactRefs.map(async ref => {
      const bytes = await getArtifactBytes(fixture.paths, ref);
      assert.ok(bytes);
      return JSON.parse(new TextDecoder().decode(bytes));
    }));
    assert.deepEqual(artifacts.find(value => value.kind === "runtime.task-model-routes")?.routes,
      { builder: ["selected"], planner: ["selected"], summarizer: ["selected"] });
  } finally { await removeFixture(fixture); }
});

test("selected-model recovery refuses changed adapters and egress before continuation", async (t) => {
  for (const change of ["model", "egress", "transport", "missing", "configuration"] as const) {
    await t.test(change, async () => {
      const fixture = await makeFixture();
      try {
        const initial = models([]);
        const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes: defaultRoutes });
        const paused = await runtime.runTask({
          workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
          configurationSnapshot, autonomy: autonomyFor([]), acceptContractAutomatically: true,
          control: async () => ({ kind: "pause", reason: "check model binding" }),
        });
        assert.equal(paused.status, "paused");
        const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        const continuation = models([envelopeFor([FINISH_ACTION])]);
        const selected: ModelAdapter = {
          ...continuation.selected,
          ...(change === "transport" ? {
            transportPermission: { subjectId: "changed.cli", executable: "changed-cli", argvPrefix: ["-p"] },
          } : {}),
          descriptor: {
            ...continuation.selected.descriptor,
            ...(change === "model" ? { modelName: "changed-model" } : {}),
            ...(change === "egress" ? {
              endpointHost: "changed.example.invalid", dataEgress: { local: false, classes: ["internal"] },
            } : {}),
          },
        };
        const restarted = await KeystoneRuntime.create({
          paths: fixture.paths, models: change === "missing" ? [continuation.fallback] : [continuation.fallback, selected],
          routes: defaultRoutes,
        });
        await assert.rejects(restarted.resumeTask(paused.taskId, change === "configuration" ? {
          configurationSnapshot: { ...configurationSnapshot, revision: "changed-revision" },
        } : {}), /configuration.*changed|selected model is unavailable/);
        const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        assert.equal(after.state().status, "paused");
        assert.deepEqual(after.events(), before.events(), "refusal must not write recovery or grant leases");
        assert.equal(continuation.selected.callCount(), 0);
        assert.equal(continuation.fallback.callCount(), 0);
      } finally { await removeFixture(fixture); }
    });
  }
});

test("unselected tasks retain distinct default role routes during recovery", async () => {
  const fixture = await makeFixture();
  try {
    const initial = models([]);
    const routes = { builder: ["default"], planner: ["selected"], summarizer: ["selected"] };
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis",
      configurationSnapshot: {
        revision: "default-role-revision", modelIds: ["default", "selected", "selected"], builderModelId: "default",
      },
      autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "unselected routes" }),
    });
    assert.equal(paused.status, "paused");
    const builder = createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "default" }), responses: [envelopeFor([FINISH_ACTION])],
    });
    const restarted = await KeystoneRuntime.create({ paths: fixture.paths, models: [builder, initial.selected], routes });
    const resumed = await restarted.resumeTask(paused.taskId);
    assert.equal(resumed.status, "exited_gracefully");
    assert.equal(builder.callCount(), 1);
    assert.equal(initial.selected.callCount(), 0);
  } finally { await removeFixture(fixture); }
});

test("selected-model recovery never restores an unselected fallback with the same primary", async () => {
  const fixture = await makeFixture();
  try {
    const initial = models([]);
    const routes = { builder: ["selected", "default"], planner: ["selected", "default"], summarizer: ["selected", "default"] };
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
      configurationSnapshot: {
        revision: "same-primary-revision", modelIds: ["selected", "selected", "selected"], builderModelId: "selected",
      },
      autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "selected singleton route" }),
    });
    assert.equal(paused.status, "paused");
    const fallback = createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "default" }), responses: [envelopeFor([FINISH_ACTION])],
    });
    let selectedCalls = 0;
    const restarted = await KeystoneRuntime.create({
      paths: fixture.paths, routes, models: [fallback, {
        descriptor: initial.selected.descriptor,
        async complete() { selectedCalls++; throw new Error("selected model unavailable"); },
      }],
    });
    await restarted.resumeTask(paused.taskId);
    assert.equal(selectedCalls, 1);
    assert.equal(fallback.callCount(), 0, "selection must retain its exact singleton route, not just the same primary");
  } finally { await removeFixture(fixture); }
});

test("legacy checkpoints reconstruct selected routes without rewriting distinct default roles", async (t) => {
  for (const selected of [true, false]) {
    await t.test(selected ? "selected model" : "distinct default roles", async () => {
      const fixture = await makeFixture();
      try {
        const initial = models([]);
        const routes = { builder: ["default"], planner: ["selected"], summarizer: ["selected"] };
        const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes });
        const paused = await runtime.runTask({
          workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis",
          ...(selected ? { modelId: "selected" } : {}),
          configurationSnapshot: {
            revision: "legacy-model-revision", modelIds: ["default", "selected", "selected"],
            builderModelId: selected ? "selected" : "default",
          },
          autonomy: autonomyFor([]), acceptContractAutomatically: true,
          control: async () => ({ kind: "pause", reason: "legacy binding" }),
        });
        assert.equal(paused.status, "paused");
        const session = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        const checkpoint = await session.latestCheckpoint();
        assert.ok(checkpoint);
        const artifactRefs: string[] = [];
        for (const ref of checkpoint.artifactRefs) {
          const bytes = await getArtifactBytes(fixture.paths, ref);
          assert.ok(bytes);
          if (JSON.parse(new TextDecoder().decode(bytes)).kind !== "runtime.task-model-routes") artifactRefs.push(ref);
        }
        // Create the pre-route-artifact checkpoint shape through the real kernel.
        await session.checkpoint("stage_boundary", {
          artifactRefs, verification: checkpoint.verification, contractDigest: checkpoint.contractDigest,
          workspaceSnapshotId: checkpoint.workspaceSnapshotId,
        });
        const builder = createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "default" }), responses: [envelopeFor([FINISH_ACTION])],
        });
        const selectedModel = createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "selected" }), responses: [envelopeFor([FINISH_ACTION])],
        });
        const restarted = await KeystoneRuntime.create({ paths: fixture.paths, models: [builder, selectedModel], routes });
        const resumed = await restarted.resumeTask(paused.taskId);
        assert.equal(resumed.status, "exited_gracefully");
        assert.equal(builder.callCount(), selected ? 0 : 1);
        assert.equal(selectedModel.callCount(), selected ? 1 : 0);
      } finally { await removeFixture(fixture); }
    });
  }
});

test("changed private-network or pinned CLI configuration rejects an otherwise identical adapter", async (t) => {
  for (const change of ["private-network", "pinned-cli"] as const) {
    await t.test(change, async () => {
      const fixture = await makeFixture();
      try {
        const entry: ModelConfigEntry = {
          id: "selected", kind: "cloud", provider: "fixture", protocol: "trae-cli-exec", modelName: "fixture",
          endpointHost: "cli.example.invalid", egressHosts: ["cli.example.invalid"], enabled: true,
          cliPath: "/fixture/cli", canonicalCliPath: "/fixture/cli", approvedCliDigest: "a".repeat(64),
          extensionName: "fixture.cli", extensionReviewHash: "c".repeat(64),
          approvedNativeAuthFile: null, allowPrivateNetwork: false,
        };
        const saved = await saveConfigSnapshot(fixture.paths, {
          revision: "missing", config: { ...defaultConfig(), models: [entry] },
        });
        const initial = models([]);
        const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes: defaultRoutes });
        const snapshot = { ...configurationSnapshot, revision: saved.revision };
        const paused = await runtime.runTask({
          workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis",
          modelId: "selected", configurationSnapshot: snapshot, autonomy: autonomyFor([]),
          acceptContractAutomatically: true, control: async () => ({ kind: "pause", reason: "pin configuration" }),
        });
        assert.equal(paused.status, "paused");
        const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        await saveConfigSnapshot(fixture.paths, {
          revision: saved.revision, config: {
            ...saved.config, models: [{ ...entry, ...(change === "private-network"
              ? { allowPrivateNetwork: true } : { approvedCliDigest: "b".repeat(64) }) }],
          },
        });
        const current = await loadConfigSnapshot(fixture.paths);
        assert.notEqual(current.revision, saved.revision);
        const continuation = models([envelopeFor([FINISH_ACTION])]);
        const restarted = await KeystoneRuntime.create({
          paths: fixture.paths, models: continuation.adapters, routes: defaultRoutes,
        });
        await assert.rejects(restarted.resumeTask(paused.taskId, {
          configurationSnapshot: { ...snapshot, revision: current.revision },
        }), /resume configuration snapshot changed/);
        const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        assert.deepEqual(after.events(), before.events());
        assert.equal(continuation.selected.callCount(), 0);
        assert.equal(continuation.fallback.callCount(), 0);
      } finally { await removeFixture(fixture); }
    });
  }
});

test("tampered recorded model routes refuse recovery before granting continuation", async () => {
  const fixture = await makeFixture();
  try {
    const initial = models([]);
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: initial.adapters, routes: defaultRoutes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
      configurationSnapshot, autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "route integrity" }),
    });
    assert.equal(paused.status, "paused");
    const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    const checkpoint = await before.latestCheckpoint();
    assert.ok(checkpoint);
    let routeRef: string | undefined;
    for (const ref of checkpoint.artifactRefs) {
      const bytes = await getArtifactBytes(fixture.paths, ref);
      assert.ok(bytes);
      if (JSON.parse(new TextDecoder().decode(bytes)).kind === "runtime.task-model-routes") routeRef = ref;
    }
    assert.ok(routeRef);
    const digest = routeRef.slice(4);
    await writeFile(join(fixture.paths.artifactsDir, digest.slice(0, 2), digest), '{"kind":"tampered"}');
    await assert.rejects(runtime.resumeTask(paused.taskId), /resume artifact missing or corrupt/);
    const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.deepEqual(after.events(), before.events());
    assert.equal(initial.selected.callCount(), 0);
    assert.equal(initial.fallback.callCount(), 0);
  } finally { await removeFixture(fixture); }
});
