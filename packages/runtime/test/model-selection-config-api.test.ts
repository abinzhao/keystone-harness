import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ExtensionLifecycleService, defaultRegistryLocation } from "@keystone/extensions";
import { getArtifactBytes, KernelSession } from "@keystone/kernel";
import {
  buildAdapter, createSequenceAdapter, defaultConfig, saveConfigSnapshot, scriptedModelDescriptor,
  type CredentialResolver, type ModelConfigEntry,
} from "@keystone/models";
import { contentHash } from "@keystone/schemas";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { ModelPluginService, buildRuntimeAdapter, withModelTransportPermissions } from "../src/model-plugins.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { autonomyFor, envelopeFor, FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

const token = "model-selection-config-test";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const defaultRoutes = { builder: ["default"], planner: ["default"], summarizer: ["default"] };
const cliEntry: ModelConfigEntry = {
  id: "selected", kind: "cloud", provider: "trae-cli", protocol: "trae-cli-exec", modelName: "fixture",
  endpointHost: "cli.example.invalid", egressHosts: ["cli.example.invalid"], enabled: true,
  cliPath: "/fixture/cli", canonicalCliPath: "/fixture/cli", approvedCliDigest: "a".repeat(64),
  extensionName: "keystone-trae-cli", extensionReviewHash: "c".repeat(64),
  approvedNativeAuthFile: null, approvedNativeModelsFile: null, allowPrivateNetwork: false,
};

async function resume(server: RunningServer, taskId: string): Promise<Response> {
  const response = await fetch(`${server.url}v1/tasks/${taskId}/resume`, {
    method: "POST", headers, body: "{}",
  });
  // Await an incorrectly admitted run too, so RED teardown cannot race ledger writes.
  if (response.status === 202) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const runResponse = await fetch(`${server.url}v1/tasks/${taskId}/run`, { headers });
      assert.equal(runResponse.status, 200);
      const run = await runResponse.json() as { status: string };
      if (run.status !== "running") break;
      assert.ok(Date.now() < deadline, "resumed run must finish before teardown");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return response;
}

test("HTTP resume refuses a recreated adapter's closure-only configuration digest before ledger effects", async (t) => {
  for (const routeBinding of [true, false]) {
    await t.test(routeBinding ? "registration binding" : "execution binding without route artifact", async () => {
      const fixture = await makeFixture();
      let server: RunningServer | undefined;
      try {
        const fallback = createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "default" }), responses: ["unused default response"],
        });
        const selected = createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: "selected" }), responses: [envelopeFor([FINISH_ACTION])],
        });
        const initial = { ...selected, configurationDigest: contentHash({ allowPrivateNetwork: false }) };
        const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [fallback, initial], routes: defaultRoutes });
        const paused = await runtime.runTask({
          workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
          configurationSnapshot: {
            revision: "closure-only", modelIds: ["default", "default", "default"], builderModelId: "selected",
          },
          autonomy: autonomyFor([]), acceptContractAutomatically: true,
          control: async () => ({ kind: "pause", reason: "freeze selected configuration" }),
        });
        assert.equal(paused.status, "paused");
        const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        if (!routeBinding) {
          const checkpoint = await before.latestCheckpoint();
          assert.ok(checkpoint);
          const artifactRefs: string[] = [];
          for (const ref of checkpoint.artifactRefs) {
            const bytes = await getArtifactBytes(fixture.paths, ref);
            assert.ok(bytes);
            if (JSON.parse(new TextDecoder().decode(bytes)).kind !== "runtime.task-model-routes") artifactRefs.push(ref);
          }
          // Exercise the execution binding independently, using a kernel-created checkpoint.
          await before.checkpoint("stage_boundary", {
            artifactRefs, verification: checkpoint.verification, contractDigest: checkpoint.contractDigest,
            workspaceSnapshotId: checkpoint.workspaceSnapshotId,
          });
        }
        server = await startServer({
          paths: fixture.paths, token, routes: defaultRoutes,
          models: [fallback, { ...selected, configurationDigest: contentHash({ allowPrivateNetwork: true }) }],
        });
        const response = await resume(server, paused.taskId);
        assert.equal(response.status, 409, "HTTP resume must reject drift without a supplied configurationSnapshot");
        assert.match((await response.json() as { error: string }).error, /configuration.*changed/);
        const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        assert.equal(after.state().status, "paused");
        assert.deepEqual(after.events(), before.events(), "refusal must precede recovery and every lease");
        assert.equal(selected.callCount(), 0);
        assert.equal(fallback.callCount(), 0);
      } finally { await server?.close(); await removeFixture(fixture); }
    });
  }
});

test("HTTP resume rejects actual CLI config drift hidden from descriptors and transport permissions", async (t) => {
  const changes: Readonly<Record<string, Partial<ModelConfigEntry>>> = {
    "private network": { allowPrivateNetwork: true },
    "approved CLI digest": { approvedCliDigest: "b".repeat(64) },
    "canonical CLI path": { canonicalCliPath: "/fixture/replacement-cli" },
    "native auth resource": { approvedNativeAuthFile: "/fixture/native/auth.json" },
    "native model metadata": { approvedNativeModelsFile: "/fixture/native/models_cache.json" },
    "declared hosts": { egressHosts: ["cli.example.invalid", "other.example.invalid"] },
  };
  for (const [name, patch] of Object.entries(changes)) {
    await t.test(name, async () => {
      const fixture = await makeFixture();
      let server: RunningServer | undefined;
      let credentialCalls = 0;
      const credentials: CredentialResolver = { async resolve() { credentialCalls++; return undefined; } };
      try {
        const saved = await saveConfigSnapshot(fixture.paths, {
          revision: "missing", config: { ...defaultConfig(), models: [cliEntry] },
        });
        const plugins = new ModelPluginService(fixture.paths,
          new ExtensionLifecycleService(defaultRegistryLocation(fixture.paths.home)));
        const selected = buildRuntimeAdapter(saved.config.models[0]!, credentials, plugins);
        const changed = plugins.build({ ...saved.config.models[0]!, ...patch });
        assert.equal(selected.configurationDigest, contentHash(saved.config.models[0]));
        assert.equal(changed.configurationDigest, contentHash({ ...saved.config.models[0]!, ...patch }));
        assert.notEqual(changed.configurationDigest, selected.configurationDigest);
        assert.deepEqual(changed.descriptor, selected.descriptor);
        assert.deepEqual(changed.transportPermission, selected.transportPermission);
        const snapshot = { revision: saved.revision, modelIds: ["selected", "selected", "selected"], builderModelId: "selected" };
        const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [selected] });
        const paused = await runtime.runTask({
          workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
          configurationSnapshot: snapshot, autonomy: withModelTransportPermissions(autonomyFor([]), [selected]),
          acceptContractAutomatically: true,
          control: async () => ({ kind: "pause", reason: "freeze CLI configuration" }),
        });
        assert.equal(paused.status, "paused");
        const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        const current = await saveConfigSnapshot(fixture.paths, {
          revision: saved.revision, config: { ...saved.config, models: [{ ...saved.config.models[0]!, ...patch }] },
        });
        assert.notEqual(current.revision, saved.revision);
        server = await startServer({ paths: fixture.paths, token, credentials });
        const response = await resume(server, paused.taskId);
        assert.equal(response.status, 409, "actual settings drift must be refused by the existing HTTP route");
        assert.match((await response.json() as { error: string }).error, /configuration.*changed/);
        const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
        assert.equal(after.state().status, "paused");
        assert.deepEqual(after.events(), before.events(), "no recovery event, model lease or native resource admission");
        assert.equal(credentialCalls, 0);
      } finally { await server?.close(); await removeFixture(fixture); }
    });
  }
});

test("HTTP resume binds an HTTP adapter's base URL path, not just its endpoint host", async () => {
  const fixture = await makeFixture();
  let server: RunningServer | undefined;
  let providerCalls = 0;
  let credentialCalls = 0;
  const credentials: CredentialResolver = { async resolve() { credentialCalls++; return "fixture-only-key"; } };
  const provider = createServer((_request, response) => {
    providerCalls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: envelopeFor([FINISH_ACTION]) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address === "object");
    const host = `127.0.0.1:${address.port}`;
    const entry: ModelConfigEntry = {
      id: "selected", kind: "local", provider: "fixture", protocol: "openai-chat", modelName: "fixture",
      endpointHost: host, baseUrl: `http://${host}/original`, credentialHandle: "fixture.http", enabled: true,
    };
    const saved = await saveConfigSnapshot(fixture.paths, {
      revision: "missing", config: { ...defaultConfig(), models: [entry] },
    });
    const selected = buildAdapter(saved.config.models[0]!, credentials);
    const changed = { ...saved.config.models[0]!, baseUrl: `http://${host}/replacement` };
    assert.deepEqual(buildAdapter(changed, credentials).descriptor, selected.descriptor);
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [selected] });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
      autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "freeze HTTP URL" }),
    });
    assert.equal(paused.status, "paused");
    const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    await saveConfigSnapshot(fixture.paths, {
      revision: saved.revision, config: { ...saved.config, models: [changed] },
    });
    server = await startServer({ paths: fixture.paths, token, credentials });
    const response = await resume(server, paused.taskId);
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /configuration.*changed/);
    const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.deepEqual(after.events(), before.events());
    assert.equal(providerCalls, 0);
    assert.equal(credentialCalls, 0);
  } finally {
    await server?.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await removeFixture(fixture);
  }
});

test("HTTP resume preserves selected configuration and frozen routes when global defaults change", async () => {
  const fixture = await makeFixture();
  let server: RunningServer | undefined;
  const providerCalls: string[] = [];
  const credentials: CredentialResolver = { async resolve() { return "fixture-only-key"; } };
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    providerCalls.push(body.model);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: envelopeFor([FINISH_ACTION]) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address === "object");
    const host = `127.0.0.1:${address.port}`;
    const entries: ModelConfigEntry[] = ["default", "next-default", "selected"].map(id => ({
      id, kind: "local", provider: "fixture", protocol: "openai-chat", modelName: id,
      endpointHost: host, baseUrl: `http://${host}/v1`, credentialHandle: "fixture.http", enabled: true,
    }));
    const saved = await saveConfigSnapshot(fixture.paths, {
      revision: "missing", config: { ...defaultConfig(), models: entries, routes: defaultRoutes, language: "en" },
    });
    const adapters = saved.config.models.map(entry => buildAdapter(entry, credentials));
    const snapshot = { revision: saved.revision, modelIds: ["default", "default", "default"], builderModelId: "selected" };
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: adapters, routes: defaultRoutes });
    const paused = await runtime.runTask({
      workspacePath: fixture.root, request: "Explain src/auth/session.js", taskIntent: "analysis", modelId: "selected",
      configurationSnapshot: snapshot, autonomy: autonomyFor([]), acceptContractAutomatically: true,
      control: async () => ({ kind: "pause", reason: "freeze selected route" }),
    });
    assert.equal(paused.status, "paused");
    const before = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    const routes = { builder: ["next-default"], planner: ["next-default"], summarizer: ["next-default"] };
    const current = await saveConfigSnapshot(fixture.paths, {
      revision: saved.revision, config: {
        ...saved.config, routes, language: "zh-CN", defaults: { ...saved.config.defaults, maxTokens: 150_000 },
      },
    });
    assert.notEqual(current.revision, saved.revision);
    server = await startServer({ paths: fixture.paths, token, credentials });
    const response = await resume(server, paused.taskId);
    assert.equal(response.status, 202, await response.clone().text());
    const after = await KernelSession.open({ paths: fixture.paths, taskId: paused.taskId });
    assert.equal(after.state().status, "exited_gracefully");
    assert.deepEqual(after.contract(), before.contract());
    assert.deepEqual(after.events().find(event => event.type === "task.created")?.payload["configurationSnapshot"], snapshot);
    assert.ok(after.events().some(event => event.type === "recovery.verified"));
    assert.deepEqual(providerCalls, ["selected"]);
    const upcoming = await fetch(`${server.url}v1/tasks`, {
      method: "POST", headers,
      body: JSON.stringify({ workspacePath: fixture.root, request: "Explain the code", taskIntent: "analysis" }),
    });
    assert.equal(upcoming.status, 202, await upcoming.clone().text());
    const { taskId } = await upcoming.json() as { taskId: string };
    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = await (await fetch(`${server.url}v1/tasks/${taskId}/run`, { headers })).json() as { status: string };
      if (run.status !== "running") break;
      assert.ok(Date.now() < deadline, "upcoming task must finish before teardown");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const next = await KernelSession.open({ paths: fixture.paths, taskId: taskId as never });
    assert.equal(next.state().status, "exited_gracefully");
    assert.deepEqual(providerCalls, ["selected", "next-default"], "new defaults apply only to upcoming tasks");
    assert.equal(next.contract()?.budget.maxTokens, 150_000);
  } finally {
    await server?.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await removeFixture(fixture);
  }
});
