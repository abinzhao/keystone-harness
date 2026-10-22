import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ExtensionLifecycleService, defaultRegistryLocation } from "@keystone/extensions";
import { resolveKeystonePaths } from "@keystone/kernel";
import { loadConfigSnapshot, type ModelConfigEntry, type ModelRequest } from "@keystone/models";
import { sha256Bytes, type CapabilityLease } from "@keystone/schemas";
import { nativeFixture, lease } from "../../extension-trae-cli/test/fixtures.ts";
import type { TransportProposal } from "../../extension-trae-cli/src/types.ts";
import { ModelPluginService } from "../src/model-plugins.ts";
import { run } from "./fixture.ts";

const request = { messages: [{ role: "user" as const, content: "Return a public synthetic answer." }], tools: [], jsonMode: true };
const native = { skip: process.platform !== "darwin" };
type Authorize = NonNullable<ModelRequest["authorizeTransport"]>;

class ObservedLifecycle extends ExtensionLifecycleService {
  subscriptions = 0;
  attached = 0;
  afterGenerate?: () => Promise<void>;
  generateRoot?: string;
  generateStarted = false;

  override onUnavailable(listener: (name: string) => void): () => void {
    this.subscriptions++; this.attached++;
    const detach = super.onUnavailable(listener);
    return () => { this.subscriptions--; detach(); };
  }

  override async list() {
    if (this.generateRoot && this.afterGenerate) {
      try { await stat(this.generateRoot); this.generateStarted = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (this.generateStarted) {
          const callback = this.afterGenerate; this.afterGenerate = undefined;
          await callback();
        }
      }
    }
    return super.list();
  }
}

async function fixture(slow?: "VERSION" | "HELP" | "GENERATION", auth = false, models = false) {
  const cli = await nativeFixture();
  const oldHome = process.env["HOME"];
  process.env["HOME"] = cli.root;
  const paths = resolveKeystonePaths(`${cli.root}/store`);
  const extensions = new ObservedLifecycle(defaultRegistryLocation(paths.home));
  const plugins = new ModelPluginService(paths, extensions);
  if (slow) await run("/usr/bin/cc", ["-O0", `-DSLOW_${slow}`, "-o", cli.executable,
    fileURLToPath(new URL("./model-plugin-lifecycle-fixture.c", import.meta.url))], { timeout: 10000 });
  if (auth) {
    await mkdir(`${cli.root}/.trae/cli`, { recursive: true });
    await writeFile(`${cli.root}/.trae/cli/auth.json`, "synthetic-unreadable-resource", { mode: 0 });
  }
  if (models) {
    await mkdir(`${cli.root}/.trae/cli`, { recursive: true });
    await writeFile(`${cli.root}/.trae/cli/models_cache.json`, "synthetic-unreadable-metadata", { mode: 0 });
  }
  const body = { confirmed: true, cliPath: cli.executable, modelId: "synthetic",
    endpointHost: "api.example.com", egressHosts: ["api.example.com"] };
  return {
    ...cli, paths, plugins, extensions, body,
    async enable(): Promise<ModelConfigEntry> {
      await plugins.operate("probe", body);
      await plugins.operate("enable", body);
      return (await loadConfigSnapshot(paths)).config.models[0]!;
    },
    async close() {
      if (oldHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = oldHome;
      await rm(cli.root, { recursive: true, force: true });
    },
  };
}

function authorizer(calls: TransportProposal[], effect?: (proposal: TransportProposal) => void | Promise<void>): Authorize {
  return async raw => {
    const proposal = raw as TransportProposal;
    calls.push(proposal); await effect?.(proposal);
    return lease(proposal) as CapabilityLease;
  };
}

test("activation persists canonical executable and explicit absent-auth approval", native, async () => {
  const f = await fixture();
  try {
    const alias = `${f.root}/selected-cli`; await symlink(f.executable, alias);
    f.body.cliPath = alias;
    const entry = await f.enable();
    assert.equal((entry as any).canonicalCliPath, await realpath(f.executable));
    assert.equal((entry as any).approvedCliDigest, sha256Bytes(await readFile(f.executable)));
    assert.equal((entry as any).approvedNativeAuthFile, null);
    assert.equal((await f.plugins.status()).enabled, true);
  } finally { await f.close(); }
});

test("same-version executable replacement is refused before any process authorization", native, async () => {
  const f = await fixture();
  try {
    const entry = await f.enable();
    await writeFile(f.executable, Buffer.concat([await readFile(f.executable), Buffer.from("changed")]));
    const calls: TransportProposal[] = [];
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, 0);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

test("retargeting an executable alias to identical bytes requires review", native, async () => {
  const f = await fixture();
  try {
    const alias = `${f.root}/selected-cli`; await symlink(f.executable, alias); f.body.cliPath = alias;
    const entry = await f.enable();
    const replacement = `${f.root}/replacement`; await copyFile(f.executable, replacement);
    await unlink(alias); await symlink(replacement, alias);
    const calls: TransportProposal[] = [];
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, 0);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

test("legacy unpinned configurations stay visible but cannot authorize transport", native, async () => {
  const f = await fixture();
  try {
    const pinned = await f.enable();
    const entry = { ...pinned, canonicalCliPath: undefined, approvedCliDigest: undefined, approvedNativeAuthFile: undefined };
    const snapshot = await loadConfigSnapshot(f.paths);
    await writeFile(f.paths.configFile, JSON.stringify({ ...snapshot.config, models: [entry] }));
    const calls: TransportProposal[] = [];
    await assert.rejects(async () => f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }), /review|approv|pin/i);
    assert.equal(calls.length, 0);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

test("native auth resource is pinned without opening its unreadable contents", native, async () => {
  const f = await fixture(undefined, true);
  try {
    const entry = await f.enable();
    assert.equal((entry as any).approvedNativeAuthFile, await realpath(`${f.root}/.trae/cli/auth.json`));
    const replacement = `${f.root}/other/auth.json`;
    await mkdir(`${f.root}/other`); await writeFile(replacement, "another-synthetic-resource", { mode: 0 });
    await unlink(`${f.root}/.trae/cli/auth.json`); await symlink(replacement, `${f.root}/.trae/cli/auth.json`);
    const calls: TransportProposal[] = [];
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, 0);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

test("a new native login resource cannot silently widen an absent-auth approval", native, async () => {
  const f = await fixture();
  try {
    const entry = await f.enable();
    await mkdir(`${f.root}/.trae/cli`, { recursive: true });
    await writeFile(`${f.root}/.trae/cli/auth.json`, "synthetic-resource", { mode: 0 });
    const calls: TransportProposal[] = [];
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, 0);
  } finally { await f.close(); }
});

test("native models metadata is pinned, passed only to generation, and rechecked before authorization", native, async () => {
  const f = await fixture(undefined, false, true);
  try {
    const entry = await f.enable(), calls: TransportProposal[] = [];
    const approved = await realpath(`${f.root}/.trae/cli/models_cache.json`);
    assert.equal((entry as any).approvedNativeModelsFile, approved);
    await f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) });
    assert.deepEqual(calls.map(p => p.parameters.nativeModelsFile), [undefined, undefined, approved]);
    await mkdir(`${f.root}/other`);
    await writeFile(`${f.root}/other/models_cache.json`, "synthetic-replacement", { mode: 0 });
    await unlink(`${f.root}/.trae/cli/models_cache.json`);
    await symlink(`${f.root}/other/models_cache.json`, `${f.root}/.trae/cli/models_cache.json`);
    const before = calls.length;
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, before);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

for (const resource of ["auth.json", "models_cache.json"] as const) {
  test(`a ${resource} identity changed after version authorization cannot authorize help`, native, async () => {
    const f = await fixture(undefined, resource === "auth.json", resource === "models_cache.json");
    try {
      const entry = await f.enable(), calls: TransportProposal[] = [];
      await mkdir(`${f.root}/other`); await writeFile(`${f.root}/other/${resource}`, "synthetic-replacement", { mode: 0 });
      await assert.rejects(f.plugins.build(entry).complete({ ...request,
        authorizeTransport: authorizer(calls, async p => {
          if (p.parameters.purpose === "version") {
            await unlink(`${f.root}/.trae/cli/${resource}`);
            await symlink(`${f.root}/other/${resource}`, `${f.root}/.trae/cli/${resource}`);
          }
        }),
      }));
      assert.deepEqual(calls.map(p => p.parameters.purpose), ["version"]);
    } finally { await f.close(); }
  });
}

test("enable rejects executable identity changed after its generation probe", native, async () => {
  const f = await fixture(undefined, true);
  try {
    await f.plugins.operate("probe", f.body);
    await writeFile(f.executable, Buffer.concat([await readFile(f.executable), Buffer.from("changed")]));
    await assert.rejects(f.plugins.operate("enable", f.body), /changed|check|review/i);
    assert.equal((await f.plugins.status()).enabled, false);
  } finally { await f.close(); }
});

test("generation probe cannot approve a native auth resource changed while it runs", native, async () => {
  const f = await fixture("GENERATION", true);
  let timer: ReturnType<typeof setTimeout> | undefined, changed: Promise<void> | undefined;
  try {
    await mkdir(`${f.root}/other`);
    const replacement = `${f.root}/other/auth.json`;
    await writeFile(replacement, "synthetic-replacement", { mode: 0 });
    timer = setTimeout(() => {
      changed = unlink(`${f.root}/.trae/cli/auth.json`).then(() => symlink(replacement, `${f.root}/.trae/cli/auth.json`));
    }, 300);
    await assert.rejects(f.plugins.operate("probe", f.body), /changed|review|integrity|authorization/i);
    await changed;
    await assert.rejects(f.plugins.operate("enable", f.body));
  } finally { if (timer) clearTimeout(timer); await changed; await f.close(); }
});

for (const phase of ["VERSION", "HELP"] as const) {
  test(`caller cancellation reaches the real ${phase.toLowerCase()} compatibility process`, native, async () => {
    const f = await fixture(phase);
    const timerIds: ReturnType<typeof setTimeout>[] = [];
    try {
      const entry = await f.enable(), calls: TransportProposal[] = [];
      const controller = new AbortController(), start = Date.now();
      await assert.rejects(f.plugins.build(entry).complete({ ...request, signal: controller.signal,
        authorizeTransport: authorizer(calls, proposal => {
          if (proposal.parameters.purpose === phase.toLowerCase()) timerIds.push(setTimeout(() => controller.abort(), 50));
        }),
      }), /cancel|abort/i);
      assert.ok(Date.now() - start < 750, "compatibility cancellation must not wait for the one-second CLI response");
      assert.deepEqual(calls.map(p => p.parameters.purpose), phase === "VERSION" ? ["version"] : ["version", "help"]);
      assert.equal(f.extensions.subscriptions, 0);
    } finally { for (const timer of timerIds) clearTimeout(timer); await f.close(); }
  });
}

for (const phase of ["VERSION", "GENERATION"] as const) {
  test(`disable interrupts an in-flight ${phase.toLowerCase()} process and refuses its response`, native, async () => {
    const f = await fixture(phase);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disabled: Promise<unknown> | undefined;
    let targetStarted: number | undefined;
    try {
      const entry = await f.enable(), calls: TransportProposal[] = [];
      await assert.rejects(f.plugins.build(entry).complete({ ...request,
        authorizeTransport: authorizer(calls, proposal => {
          if (proposal.parameters.purpose === (phase === "VERSION" ? "version" : "generate")) {
            // Compatibility probes precede generation; cancellation latency
            // starts at admission of the specific child being interrupted.
            targetStarted = Date.now();
            timer = setTimeout(() => { disabled = f.extensions.disable(entry.extensionName!); }, 50);
          }
        }),
      }));
      await disabled;
      assert.ok(targetStarted !== undefined, "the selected subprocess must reach admission");
      assert.ok(Date.now() - targetStarted < 750, "disable must interrupt the real child rather than wait for its response");
      assert.equal(f.extensions.subscriptions, 0);
    } finally { if (timer) clearTimeout(timer); await disabled; await f.close(); }
  });
}

test("already-aborted calls cannot authorize compatibility and subscriptions are disposed", native, async () => {
  const f = await fixture();
  try {
    const entry = await f.enable(), calls: TransportProposal[] = [], controller = new AbortController();
    controller.abort();
    await assert.rejects(f.plugins.build(entry).complete({ ...request, signal: controller.signal, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, 0);
    const attached = f.extensions.attached;
    await f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) });
    assert.equal(f.extensions.attached, attached + 1);
    assert.equal(f.extensions.subscriptions, 0);
  } finally { await f.close(); }
});

for (const change of ["abort", "disable"] as const) {
  test(`completed process output is rejected when ${change} occurs during final lifecycle validation`, native, async () => {
    const f = await fixture();
    try {
      const entry = await f.enable(), calls: TransportProposal[] = [], controller = new AbortController();
      f.extensions.afterGenerate = async () => {
        if (change === "abort") controller.abort();
        else await f.extensions.disable(entry.extensionName!);
      };
      await assert.rejects(f.plugins.build(entry).complete({ ...request, signal: controller.signal,
        authorizeTransport: authorizer(calls, p => {
          if (p.parameters.purpose === "generate") f.extensions.generateRoot = p.parameters.temporaryRoot;
        }),
      }));
      assert.equal(f.extensions.afterGenerate, undefined, "the real lifecycle service must revalidate after process cleanup");
      assert.equal(f.extensions.subscriptions, 0);
    } finally { await f.close(); }
  });
}

test("isolation violation persists quarantine across per-call adapters and service recreation", native, async () => {
  const f = await fixture();
  try {
    const entry = { ...await f.enable(), modelName: "tool" }, calls: TransportProposal[] = [];
    await assert.rejects(f.plugins.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }), { code: "isolation_violation" });
    const registered = (await f.extensions.list()).find(row => row.manifest.name === entry.extensionName);
    assert.equal(registered?.status, "isolated");
    assert.match(registered?.isolationReason ?? "", /isolation_violation/);
    const before = calls.length;
    await assert.rejects(f.plugins.build({ ...entry, modelName: "synthetic" }).complete({ ...request, authorizeTransport: authorizer(calls) }));
    const restarted = new ModelPluginService(f.paths, new ExtensionLifecycleService(defaultRegistryLocation(f.paths.home)));
    await assert.rejects(restarted.build(entry).complete({ ...request, authorizeTransport: authorizer(calls) }));
    assert.equal(calls.length, before);
    assert.equal((await restarted.status()).enabled, false);
    assert.equal(f.extensions.subscriptions, 0);
  } finally { await f.close(); }
});

test("isolation violation aborts another real in-flight model call", native, async () => {
  const f = await fixture();
  try {
    const entry = await f.enable(), calls: TransportProposal[] = [];
    let generated!: () => void;
    const generating = new Promise<void>(resolve => { generated = resolve; });
    const pending = f.plugins.build({ ...entry, modelName: "timeout" }).complete({ ...request,
      authorizeTransport: authorizer(calls, p => { if (p.parameters.purpose === "generate") generated(); }),
    });
    const cancelled = assert.rejects(pending, /cancel|abort/i);
    await generating;
    const start = Date.now();
    await assert.rejects(f.plugins.build({ ...entry, modelName: "tool" }).complete({ ...request,
      authorizeTransport: authorizer(calls),
    }), { code: "isolation_violation" });
    await cancelled;
    assert.ok(Date.now() - start < 2000, "quarantine must kill the other bounded child rather than await its timeout");
    assert.equal(f.extensions.subscriptions, 0);
  } finally { await f.close(); }
});

test("quarantine notifies other model services sharing the extension lifecycle", native, async () => {
  const f = await fixture("GENERATION");
  try {
    const entry = await f.enable(), calls: TransportProposal[] = [];
    const other = new ModelPluginService(f.paths, f.extensions);
    let generated!: () => void;
    const generating = new Promise<void>(resolve => { generated = resolve; });
    const pending = other.build({ ...entry, modelName: "timeout" }).complete({ ...request,
      authorizeTransport: authorizer(calls, p => { if (p.parameters.purpose === "generate") generated(); }),
    });
    const cancelled = assert.rejects(pending, /cancel|abort/i);
    await generating;
    await assert.rejects(f.plugins.build({ ...entry, modelName: "tool" }).complete({ ...request,
      authorizeTransport: authorizer(calls),
    }), { code: "isolation_violation" });
    await cancelled;
    assert.equal(f.extensions.subscriptions, 0);
  } finally { await f.close(); }
});
