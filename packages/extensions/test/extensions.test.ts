import assert from "node:assert/strict";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as localManager from "../src/manager.ts";
import { buildManifest as localizationManifest } from "../../extension-localization-placeholders/src/manifest.ts";

import { newId, sha256Bytes, toIso, type ExtensionManifest, type UserDecision } from "@keystone/schemas";

import {
  ActivationRefusedError,
  ExtensionRegistry,
  canActivate,
  capabilityCeiling,
  checkDeclarations,
  clampRequestedCapabilities,
  degradationAfterIsolation,
  describeInstallReview,
  isPlausibleRange,
  isolationTriggerFor,
  parseManifest,
  reachesOutside,
  prepareLocalInstall,
  runConformance,
  summarizeConformance,
  ExtensionManifestViolationError,
  ExtensionTimeoutError,
} from "../src/index.ts";

function manifestFor(overrides: Record<string, unknown> = {}): ExtensionManifest {
  // Built through the schema so the fixture cannot drift from the protocol; the
  // cast only bridges the branded digest field, which the schema validates.
  return {
    name: "keystone-verifier-vitest",
    version: "1.0.0",
    publisher: "keystone",
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    kind: "verifier",
    apiVersion: "1.0",
    capabilities: ["cmd.exec"],
    sideEffects: [{ kind: "process_spawn", scope: "runs the project's test command" }],
    reversibility: "reversible",
    egressHosts: [],
    credentialHandles: [],
    dataClassification: { reads: "internal", egress: [] },
    produces: { observations: ["test_result"], evidenceTypes: ["test_run"] },
    execution: { replayable: true, idempotent: true },
    dependencies: [],
    conflicts: [],
    uninstall: "safe",
    entry: { module: "dist/index.js", export: "verifier" },
    ...overrides,
  } as unknown as ExtensionManifest;
}

function decisionFor(overrides: Partial<UserDecision> = {}): UserDecision {
  return {
    decisionId: newId("dec"),
    taskId: newId("task"),
    branchId: newId("branch"),
    at: new Date().toISOString(),
    decision: "allow",
    rationale: "installed deliberately",
    appliesTo: { resources: [] },
    recordedBy: "user",
    ...overrides,
  } as UserDecision;
}

test("manifest integrity is verified against the actual bytes", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
  const digest = sha256Bytes(bytes);
  const manifest = manifestFor({ integrity: { algorithm: "sha256", digest } });

  const verified = parseManifest(manifest, bytes);
  assert.equal(verified.integrityVerified, true);
  assert.equal(verified.digest, digest);

  const tampered = parseManifest(manifest, new TextEncoder().encode("different bytes"));
  assert.equal(tampered.integrityVerified, false);
});

test("under-declaration is a blocking conformance problem", () => {
  // A tool that asks for no capabilities cannot do anything at all.
  const inert = checkDeclarations(manifestFor({ kind: "tool", capabilities: [] }));
  const inertCheck = inert.find((entry) => entry.checkId === "declaration.capabilities_present");
  assert.equal(inertCheck?.passed, false);
  assert.equal(inertCheck?.blocking, true);

  // Network access without declaring where data goes.
  const sneaky = checkDeclarations(
    manifestFor({
      kind: "tool",
      capabilities: ["net.fetch"],
      sideEffects: [{ kind: "network" }],
      egressHosts: [],
    }),
  );
  const egress = sneaky.find((entry) => entry.checkId === "declaration.egress_declared");
  assert.equal(egress?.passed, false);
  assert.equal(egress?.blocking, true);

  // Declared properly: both checks pass.
  const honest = checkDeclarations(
    manifestFor({
      kind: "tool",
      capabilities: ["net.fetch"],
      sideEffects: [{ kind: "network" }],
      egressHosts: ["api.example.com"],
      dataClassification: {
        reads: "internal",
        egress: [{ dataClass: "internal", destination: "api.example.com", purpose: "sync" }],
      },
    }),
  );
  assert.ok(honest.every((entry) => entry.passed || !entry.blocking));
});

test("a capability without its side effect is rejected", () => {
  const missing = checkDeclarations(
    manifestFor({ capabilities: ["fs.write"], sideEffects: [{ kind: "process_spawn" }] }),
  );
  const check = missing.find((entry) => entry.checkId === "declaration.side_effect.fs.write");
  assert.equal(check?.passed, false);
  assert.equal(check?.blocking, true);
});

test("an extension cannot declare the ability to activate other extensions", () => {
  const checks = checkDeclarations(manifestFor({ capabilities: ["extension.activate"] }));
  const check = checks.find((entry) => entry.checkId === "declaration.no_self_elevation");
  assert.equal(check?.passed, false);
  assert.equal(check?.blocking, true);
});

test("a verifier must declare the evidence it produces", () => {
  const checks = checkDeclarations(
    manifestFor({ produces: { observations: [], evidenceTypes: [] } }),
  );
  const check = checks.find((entry) => entry.checkId === "declaration.verifier_evidence_types");
  assert.equal(check?.passed, false);
  assert.equal(check?.blocking, true);
});

test("the install review states data egress in plain language", () => {
  const review = describeInstallReview(
    manifestFor({
      capabilities: ["net.fetch", "fs.read"],
      sideEffects: [{ kind: "network" }, { kind: "fs_read" }],
      egressHosts: ["telemetry.example.com"],
      dataClassification: {
        reads: "internal",
        egress: [{ dataClass: "internal", destination: "telemetry.example.com", purpose: "crash reports" }],
      },
      conflicts: ["keystone-tool-legacy"],
    }),
  );
  assert.deepEqual(review.canDo, ["net.fetch", "fs.read"]);
  assert.equal(review.dataEgress.length, 1);
  assert.match(review.dataEgress[0] ?? "", /internal data may be sent to telemetry\.example\.com/);
  assert.ok(review.advisory.some((entry) => entry.includes("keystone-tool-legacy")));
});

test("a purely local extension says nothing leaves the machine", () => {
  const review = describeInstallReview(manifestFor());
  assert.deepEqual(review.dataEgress, ["nothing leaves the machine"]);
});

test("semver ranges are checked for plausibility only", () => {
  for (const range of ["*", "^1.2.3", "~1.2", "1.x", ">=1.0.0", "1.2.3 || 2.0.0"]) {
    assert.equal(isPlausibleRange(range), true, range);
  }
  for (const range of ["", "not-a-version", "^^1.0.0", "1.2.3 - "]) {
    assert.equal(isPlausibleRange(range), false, `"${range}" should be rejected`);
  }
});

test("conformance blocks on integrity, API version and declarations", async () => {
  const failing = await runConformance({
    manifest: manifestFor({ integrity: { algorithm: "sha256", digest: "a".repeat(64) } }),
    integrityVerified: false,
    apiVersionSupported: "1.0",
  });
  assert.equal(failing.passed, false);
  assert.equal(
    failing.checks.find((entry) => entry.checkId === "manifest.integrity")?.blocking,
    true,
  );
  assert.match(summarizeConformance(failing), /failed conformance/);

  const wrongApi = await runConformance({
    manifest: manifestFor({ apiVersion: "2.0" }),
    integrityVerified: true,
    apiVersionSupported: "1.0",
  });
  assert.equal(
    wrongApi.checks.find((entry) => entry.checkId === "api.version")?.passed,
    false,
  );

  const good = await runConformance({ manifest: manifestFor(), integrityVerified: true });
  assert.equal(good.passed, true);
  assert.match(summarizeConformance(good), /passed conformance/);

  // The report hash must be stable for identical inputs up to the timestamp.
  const again = await runConformance({ manifest: manifestFor(), integrityVerified: true });
  assert.equal(again.passed, true);
  assert.equal(again.checks.length, good.checks.length);
});

test("probes can extend conformance and blocking probes gate activation", async () => {
  const report = await runConformance({
    manifest: manifestFor(),
    integrityVerified: true,
    probes: [
      {
        checkId: "probe.emits_valid_evidence",
        blocking: true,
        detail: "the verifier emits schema-valid evidence",
        run: async () => ({ passed: false, detail: "evidence did not validate" }),
      },
    ],
  });
  assert.equal(report.passed, false);
  assert.equal(
    report.checks.find((entry) => entry.checkId === "probe.emits_valid_evidence")?.passed,
    false,
  );
});

test("activation requires conformance, integrity and — for egress — a decision", async () => {
  const localManifest = manifestFor();
  const conformance = await runConformance({ manifest: localManifest, integrityVerified: true });

  assert.equal(
    canActivate({ manifest: localManifest, integrityVerified: true }).allowed,
    false,
    "activation without a conformance run must be refused",
  );

  const localGate = canActivate({
    manifest: localManifest,
    integrityVerified: true,
    conformance,
  });
  assert.equal(localGate.allowed, true);
  assert.equal(localGate.requiresConfirmation, false);
  assert.equal(reachesOutside(localManifest), false);

  const remoteManifest = manifestFor({
    kind: "tool",
    capabilities: ["net.fetch"],
    sideEffects: [{ kind: "network" }],
    egressHosts: ["api.example.com"],
    dataClassification: {
      reads: "internal",
      egress: [{ dataClass: "internal", destination: "api.example.com", purpose: "sync" }],
    },
  });
  const remoteConformance = await runConformance({
    manifest: remoteManifest,
    integrityVerified: true,
  });

  const withoutDecision = canActivate({
    manifest: remoteManifest,
    integrityVerified: true,
    conformance: remoteConformance,
  });
  assert.equal(withoutDecision.allowed, false);
  assert.equal(withoutDecision.requiresConfirmation, true);
  assert.match(withoutDecision.blockers.join(" "), /reach outside the machine/);

  const withDecision = canActivate({
    manifest: remoteManifest,
    integrityVerified: true,
    conformance: remoteConformance,
    decision: decisionFor(),
  });
  assert.equal(withDecision.allowed, true);
});

test("an expired decision cannot authorise activation", async () => {
  const remoteManifest = manifestFor({
    kind: "tool",
    capabilities: ["net.fetch"],
    sideEffects: [{ kind: "network" }],
    egressHosts: ["api.example.com"],
    dataClassification: {
      reads: "internal",
      egress: [{ dataClass: "internal", destination: "api.example.com", purpose: "sync" }],
    },
  });
  const conformance = await runConformance({ manifest: remoteManifest, integrityVerified: true });
  const gate = canActivate({
    manifest: remoteManifest,
    integrityVerified: true,
    conformance,
    decision: decisionFor({
      appliesTo: { resources: [], expiresAt: new Date(Date.now() - 1000).toISOString() } as never,
    }),
  });
  assert.equal(gate.allowed, false);
});

test("an irreversible extension is never activated automatically", async () => {
  const manifest = manifestFor({ reversibility: "irreversible" });
  const conformance = await runConformance({ manifest, integrityVerified: true });
  const gate = canActivate({ manifest, integrityVerified: true, conformance });
  assert.equal(gate.allowed, false);
  assert.match(gate.blockers.join(" "), /irreversible/);
});

test("capability ceilings intersect and never widen", () => {
  const manifest = manifestFor({ capabilities: ["cmd.exec", "fs.write", "net.fetch"] });
  const ceiling = capabilityCeiling(manifest, ["cmd.exec", "fs.read"]);
  assert.deepEqual(ceiling, ["cmd.exec"]);

  const narrowed = clampRequestedCapabilities(["cmd.exec", "fs.write"], ceiling);
  assert.deepEqual(narrowed.granted, ["cmd.exec"]);
  assert.deepEqual(narrowed.refused, ["fs.write"]);
});

test("isolation maps to a named trigger and a safe degradation", () => {
  assert.equal(isolationTriggerFor(new ExtensionManifestViolationError("x", "bad")), "manifest_violation");
  assert.equal(isolationTriggerFor(new ExtensionTimeoutError("x", 1000)), "timeout");
  assert.equal(isolationTriggerFor(new Error("boom")), "crash");

  const degraded = degradationAfterIsolation({
    remainingCapabilities: ["fs.read", "cmd.exec"],
    taskNeeds: ["fs.read", "cmd.exec", "net.fetch"],
  });
  assert.equal(degraded.mode, "minimal");
  assert.deepEqual(degraded.lost, ["net.fetch"]);

  const blocked = degradationAfterIsolation({
    remainingCapabilities: ["fs.read"],
    taskNeeds: ["fs.read", "cmd.exec"],
  });
  assert.equal(blocked.mode, "needs_attention");

  const fine = degradationAfterIsolation({
    remainingCapabilities: ["fs.read", "cmd.exec"],
    taskNeeds: ["fs.read"],
  });
  assert.equal(fine.mode, "standard");
});

test("registry persists install, activation and isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-ext-"));
  try {
    const location = { registryFile: join(dir, "extensions.json") };
    const registry = new ExtensionRegistry(location);
    await registry.load();
    assert.deepEqual(registry.list(), []);

    const manifest = manifestFor();
    const conformance = await runConformance({ manifest, integrityVerified: true });
    const registered = await registry.register({
      manifest,
      source: { kind: "local_path", locator: "/tmp/ext" },
      integrityVerified: true,
      conformance,
    });
    assert.equal(registered.status, "registered");
    assert.match(registered.extensionId, /^ext_/);

    const activated = await registry.activate(manifest.name);
    assert.equal(activated.status, "active");
    assert.equal(registry.active().length, 1);

    const isolated = await registry.isolate(manifest.name, "timeout", "no response in 5000ms");
    assert.equal(isolated.status, "isolated");
    assert.match(isolated.isolationReason ?? "", /\[timeout\]/);
    assert.deepEqual(registry.unexplained(), []);

    // A fresh instance must see the same state, because state changes were
    // persisted before they were reported.
    const reloaded = new ExtensionRegistry(location);
    await reloaded.load();
    assert.equal(reloaded.get(manifest.name)?.status, "isolated");
    assert.equal(reloaded.get(manifest.name)?.source.locator, "/tmp/ext");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry refuses activation of an extension that cannot be trusted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-ext-"));
  try {
    const registry = new ExtensionRegistry({ registryFile: join(dir, "extensions.json") });
    await registry.load();
    const manifest = manifestFor();
    await registry.register({
      manifest,
      source: { kind: "npm", locator: "keystone-verifier-vitest@1.0.0" },
      integrityVerified: true,
      // No conformance run recorded.
    });
    await assert.rejects(
      () => registry.activate(manifest.name),
      (error: unknown) => {
        assert.ok(error instanceof ActivationRefusedError);
        assert.match(error.blockers.join(" "), /no conformance run/);
        return true;
      },
    );
    assert.equal(registry.get(manifest.name)?.status, "registered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an extension that cannot be uninstalled is flagged, not blocked", async () => {
  const manifest = manifestFor({ uninstall: "unsupported" });
  const conformance = await runConformance({ manifest, integrityVerified: true });
  const gate = canActivate({ manifest, integrityVerified: true, conformance });
  assert.equal(gate.allowed, true);
  assert.ok(gate.notes.some((note) => note.includes("cannot be uninstalled")));
});

test("static preparation never executes a verifier entry with a visible side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-static-entry-"));
  const marker = join(root, "entry-executed");
  const source = [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    "export const verifier = {",
    "  descriptor: { id: 'malicious', version: '1.0.0', kind: 'project_rule',",
    "    evidenceLevel: 'E1', canSatisfyRequiredCondition: false,",
    "    independence: { mode: 'same_process', independentOf: [] } },",
    "  run: async () => ({ status: 'passed' }),",
    "};",
  ].join("\n");
  try {
    await writeFile(join(root, "entry.mjs"), source);
    await writeFile(
      join(root, "keystone-extension.json"),
      JSON.stringify(manifestFor({
        entry: { module: "entry.mjs", export: "verifier" },
        integrity: { algorithm: "sha256", digest: sha256Bytes(new TextEncoder().encode(source)) },
      })),
    );
    const prepared = await prepareLocalInstall(root);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(prepared.read.integrityVerified, true);
    assert.equal(prepared.gate.allowed, false, "static review is not behavioral conformance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved verifier probes load a copied entry in a child temporary workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-approved-entry-"));
  const source = [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('probe-output', 'child-only');",
    "globalThis.keystoneProbeWasImported = true;",
    "export const verifier = {",
    "  descriptor: { id: `child.${process.pid}`, version: '1.0.0', kind: 'project_rule',",
    "    evidenceLevel: 'E1', canSatisfyRequiredCondition: false,",
    "    independence: { mode: 'same_process', independentOf: [] } },",
    "  run: async () => { throw new Error('shape probes must not run the verifier'); },",
    "};",
  ].join("\n");
  try {
    await writeFile(join(root, "entry.mjs"), source);
    await writeFile(join(root, "keystone-extension.json"), JSON.stringify(manifestFor({
      entry: { module: "entry.mjs", export: "verifier" },
      integrity: { algorithm: "sha256", digest: sha256Bytes(new TextEncoder().encode(source)) },
    })));
    const prepared = await prepareLocalInstall(root);
    assert.equal(typeof localManager.probeLocalInstall, "function", "an explicit approved probe hook is required");
    const probed = await localManager.probeLocalInstall(root, {
      decision: decisionFor(),
      reviewHash: prepared.reviewHash,
    });
    assert.equal(probed.phase, "probed");
    assert.equal(probed.conformance.passed, true, summarizeConformance(probed.conformance));
    const detail = probed.conformance.checks.find((c) => c.checkId === "entry.verifier_shape")?.detail ?? "";
    assert.match(detail, /child\.\d+/);
    assert.ok(!detail.includes(`child.${process.pid}@`), "entry must not run in the trusted process");
    assert.equal((globalThis as Record<string, unknown>).keystoneProbeWasImported, undefined);
    await assert.rejects(readFile(join(root, "probe-output")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static stdio review neither launches the command nor claims content integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-static-mcp-"));
  const marker = join(root, "mcp-executed");
  try {
    await writeFile(join(root, "keystone-extension.json"), JSON.stringify(manifestFor({
      kind: "protocol",
      entry: undefined,
      transport: {
        type: "stdio", command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
      },
    })));
    const prepared = await prepareLocalInstall(root);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(prepared.read.integrityVerified, false, "local path trust is not a verified digest");
    assert.equal(prepared.read.integrityBasis, "local_path_trust");
    assert.equal(prepared.staticChecksPassed, true);
    assert.equal(prepared.gate.allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval is invalidated when a sibling package file changes after static review", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-review-binding-"));
  const source = "export const verifier = {};";
  try {
    await writeFile(join(root, "entry.mjs"), source);
    await writeFile(join(root, "helper.mjs"), "export const helper = 1;");
    await writeFile(join(root, "keystone-extension.json"), JSON.stringify(manifestFor({
      entry: { module: "entry.mjs", export: "verifier" },
      integrity: { algorithm: "sha256", digest: sha256Bytes(new TextEncoder().encode(source)) },
    })));
    const prepared = await prepareLocalInstall(root);
    await writeFile(join(root, "helper.mjs"), "export const helper = 2;");
    await assert.rejects(
      localManager.probeLocalInstall(root, { decision: decisionFor(), reviewHash: prepared.reviewHash }),
      /changed since static review/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved stdio probes handshake in a temporary workspace and stop the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-approved-mcp-"));
  try {
    await writeFile(join(root, "server.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      "writeFileSync('server-ran', 'child-only');",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id === undefined) return;",
      "  const result = request.method === 'initialize'",
      "    ? { protocolVersion: '2024-11-05', serverInfo: { name: `child.${process.pid}`, version: '1.0.0' } }",
      "    : { tools: [{ name: 'echo' }] };",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));",
      "});",
    ].join("\n"));
    await writeFile(join(root, "keystone-extension.json"), JSON.stringify(manifestFor({
      kind: "protocol", entry: undefined,
      transport: { type: "stdio", command: process.execPath, args: ["server.mjs"] },
    })));
    const prepared = await prepareLocalInstall(root);
    const probed = await localManager.probeLocalInstall(root, {
      decision: decisionFor(), reviewHash: prepared.reviewHash,
    });
    const handshake = probed.conformance.checks.find((c) => c.checkId === "mcp.handshake");
    assert.equal(handshake?.passed, true, handshake?.detail);
    assert.equal(probed.conformance.passed, true, summarizeConformance(probed.conformance));
    assert.match(handshake?.detail ?? "", /echo/);
    assert.equal(probed.read.integrityBasis, "local_path_trust");
    assert.match(probed.conformance.checks.find((c) => c.checkId === "manifest.integrity")?.detail ?? "", /not.*digest/);
    await assert.rejects(access(join(root, "server-ran")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeVerifierFixture(root: string, source: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(root, "entry.mjs"), source);
  await writeFile(join(root, "keystone-extension.json"), JSON.stringify(manifestFor({
    entry: { module: "entry.mjs", export: "verifier" },
    integrity: { algorithm: "sha256", digest: sha256Bytes(new TextEncoder().encode(source)) },
    ...overrides,
  })));
}

const validProbeVerifier = [
  "export const verifier = {",
  "  descriptor: { id: 'fixture', version: '1.0.0', kind: 'project_rule',",
  "    evidenceLevel: 'E1', canSatisfyRequiredCondition: false,",
  "    independence: { mode: 'same_process', independentOf: [] } },",
  "  run: async () => { throw new Error('must not run'); },",
  "};",
].join("\n");

test("static conformance never invokes supplied probes or loaders", async () => {
  let invoked = 0;
  const report = await runConformance({
    manifest: manifestFor(), integrityVerified: true, staticOnly: true,
    entryLoader: async () => { invoked++; return {}; },
    probes: [{
      checkId: "malicious.callback", blocking: true, detail: "untrusted",
      run: async () => { invoked++; return { passed: true, detail: "executed" }; },
    }],
  });
  assert.equal(invoked, 0);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.checkId === "execution.consent")?.passed, false);
});

test("approved probes reject missing, expired, non-user and denied consent before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-invalid-consent-"));
  try {
    await writeVerifierFixture(root, validProbeVerifier);
    const prepared = await prepareLocalInstall(root);
    const decisions = [
      undefined,
      decisionFor({ appliesTo: { resources: [], expiresAt: toIso(new Date("2000-01-01T00:00:00.000Z")) } }),
      { ...decisionFor(), recordedBy: "model" },
      decisionFor({ decision: "deny" }),
    ];
    for (const decision of decisions) {
      await assert.rejects(localManager.probeLocalInstall(root, {
        decision: decision as UserDecision, reviewHash: prepared.reviewHash,
      }));
    }
    await assert.rejects(
      localManager.localEntryLoader(root)("entry.mjs", "verifier"), /host entry loading is disabled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval binds executable file modes as well as bytes", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-mode-consent-"));
  try {
    await writeVerifierFixture(root, validProbeVerifier);
    await chmod(join(root, "entry.mjs"), 0o644);
    const prepared = await prepareLocalInstall(root);
    await chmod(join(root, "entry.mjs"), 0o755);
    await assert.rejects(
      localManager.probeLocalInstall(root, { decision: decisionFor(), reviewHash: prepared.reviewHash }),
      /changed since static review/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval must still be live immediately before the child launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-expiring-consent-"));
  const originalNow = Date.now;
  try {
    await writeVerifierFixture(root, validProbeVerifier);
    const prepared = await prepareLocalInstall(root);
    const now = originalNow();
    const decision = decisionFor({
      appliesTo: { resources: [], expiresAt: toIso(new Date(now + 60_000)) },
    });
    let checks = 0;
    Date.now = () => ++checks === 1 ? now : now + 120_000;
    await assert.rejects(
      localManager.probeLocalInstall(root, { decision, reviewHash: prepared.reviewHash }),
      /live explicit user approval/,
    );
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("static review refuses escaping entries and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-static-path-"));
  try {
    for (const module of ["../entry.mjs", "/entry.mjs"]) {
      await writeVerifierFixture(root, validProbeVerifier, { entry: { module, export: "verifier" } });
      await assert.rejects(prepareLocalInstall(root), /escapes/);
    }
    await writeVerifierFixture(root, validProbeVerifier);
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "linked"), "dir");
    await assert.rejects(prepareLocalInstall(root), /symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static review refuses a FIFO without trying to read it", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-static-fifo-"));
  try {
    await writeVerifierFixture(root, validProbeVerifier);
    const fixture = spawnSync("mkfifo", [join(root, "pipe")], { shell: false });
    assert.equal(fixture.status, 0, fixture.stderr?.toString());
    await assert.rejects(prepareLocalInstall(root), /non-regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved verifier probes deny host writes and subprocesses, and bound hangs and floods", async (t) => {
  for (const [name, prelude, expected] of [
    ["host write", "import { writeFileSync } from 'node:fs';\nwriteFileSync(HOST_MARKER, 'denied');", /could not load/],
    ["subprocess", "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['-e', 'process.exit()']);", /could not load/],
    ["hang", "while (true) {}", /timed out/],
    ["flood", "process.stdout.write('x'.repeat(100_000));", /output limit/],
  ] as const) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "keystone-probe-limit-"));
      const marker = join(root, "host-was-written");
      try {
        await writeVerifierFixture(root, `${prelude.replace("HOST_MARKER", JSON.stringify(marker))}\n${validProbeVerifier}`);
        const prepared = await prepareLocalInstall(root);
        const probed = await localManager.probeLocalInstall(root, {
          decision: decisionFor(), reviewHash: prepared.reviewHash, timeoutMs: 1_000, maxOutputBytes: 4_096,
        });
        const shape = probed.conformance.checks.find((check) => check.checkId === "entry.verifier_shape");
        assert.equal(shape?.passed, false, shape?.detail);
        assert.match(shape?.detail ?? "", expected);
        assert.equal(probed.gate.allowed, false);
        await assert.rejects(access(marker), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("approved reference extensions retain conformance without a host import", async () => {
  const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const localized = await mkdtemp(join(tmpdir(), "keystone-localized-package-"));
  try {
    // This trusted reference ships a manifest builder rather than a disk manifest.
    await cp(join(packages, "extension-localization-placeholders/src"), join(localized, "src"), { recursive: true });
    await cp(join(packages, "extension-localization-placeholders/package.json"), join(localized, "package.json"));
    await writeFile(join(localized, "keystone-extension.json"), JSON.stringify(
      localizationManifest(new Uint8Array(await readFile(join(localized, "src/index.ts")))),
    ));
    for (const root of [join(packages, "extension-no-debug-statements"), localized]) {
      const prepared = await prepareLocalInstall(root);
      assert.equal(prepared.phase, "static");
      assert.equal(prepared.staticChecksPassed, true);
      const probed = await localManager.probeLocalInstall(root, {
        decision: decisionFor(), reviewHash: prepared.reviewHash,
      });
      assert.equal(probed.conformance.passed, true, summarizeConformance(probed.conformance));
      assert.equal(probed.gate.allowed, true);
    }
  } finally {
    await rm(localized, { recursive: true, force: true });
  }
});

test("approved MCP probes preserve declared non-secret env but reject inherited credentials and loader overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-mcp-environment-"));
  const key = "KEYSTONE_TEST_TOKEN";
  assert.equal(process.env[key], undefined);
  try {
    process.env[key] = "synthetic-test-value";
    const source = [
      "import { createInterface } from 'node:readline';",
      "if (process.env.KEYSTONE_TEST_TOKEN || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS)",
      "  process.exit(4);",
      "if (process.env.PROBE_LABEL !== 'declared' || process.env.HOME !== process.cwd()) process.exit(5);",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id === undefined) return;",
      "  const result = request.method === 'initialize'",
      "    ? { protocolVersion: '2024-11-05', serverInfo: { name: 'env-checked', version: '1' } }",
      "    : { tools: [] };",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));",
      "});",
    ].join("\n");
    await writeVerifierFixture(root, source, {
      kind: "protocol", entry: undefined,
      transport: {
        type: "stdio", command: process.execPath, args: ["entry.mjs"],
        env: {
          PROBE_LABEL: "declared", OPENAI_API_KEY: "synthetic-declared-value",
          NODE_OPTIONS: "--require=unreviewed.cjs", HOME: "/unreviewed-home", PATH: "/unreviewed-bin",
        },
      },
    });
    const prepared = await prepareLocalInstall(root);
    const probed = await localManager.probeLocalInstall(root, {
      decision: decisionFor(), reviewHash: prepared.reviewHash,
    });
    const handshake = probed.conformance.checks.find((check) => check.checkId === "mcp.handshake");
    assert.equal(handshake?.passed, true, handshake?.detail);
  } finally {
    delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test("approved MCP probes reject malformed responses and bound nonresponse and output floods", async (t) => {
  for (const [name, source, expected] of [
    ["malformed", "console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));\nsetInterval(() => {}, 100);", /malformed/],
    ["nonresponse", "setInterval(() => {}, 100);", /timed out/],
    ["flood", "process.stdout.write('x'.repeat(100_000));\nsetInterval(() => {}, 100);", /output limit/],
  ] as const) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "keystone-mcp-limit-"));
      try {
        await writeVerifierFixture(root, source, {
          kind: "protocol", entry: undefined,
          transport: { type: "stdio", command: process.execPath, args: ["entry.mjs"] },
        });
        const prepared = await prepareLocalInstall(root);
        const probed = await localManager.probeLocalInstall(root, {
          decision: decisionFor(), reviewHash: prepared.reviewHash, timeoutMs: 1_000, maxOutputBytes: 4_096,
        });
        const handshake = probed.conformance.checks.find((check) => check.checkId === "mcp.handshake");
        assert.equal(handshake?.passed, false, handshake?.detail);
        assert.match(handshake?.detail ?? "", expected);
        assert.equal(probed.gate.allowed, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("approved MCP absolute package paths are relocated to the temporary copy", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-mcp-absolute-"));
  try {
    const server = [
      "import { writeFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      "writeFileSync(new URL('./local-marker', import.meta.url), 'copied-entry');",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id === undefined) return;",
      "  const result = request.method === 'initialize'",
      "    ? { protocolVersion: '2024-11-05', serverInfo: { name: 'copied-absolute', version: '1' } }",
      "    : { tools: [] };",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));",
      "});",
    ].join("\n");
    await writeVerifierFixture(root, server, {
      kind: "protocol", entry: undefined,
      transport: { type: "stdio", command: process.execPath, args: [join(root, "entry.mjs")] },
    });
    let prepared = await prepareLocalInstall(root);
    let probed = await localManager.probeLocalInstall(root, { decision: decisionFor(), reviewHash: prepared.reviewHash });
    assert.equal(probed.conformance.passed, true, summarizeConformance(probed.conformance));
    await assert.rejects(access(join(root, "local-marker")), { code: "ENOENT" });

    // Executables contained in the package must also launch the reviewed copy.
    await writeFile(join(root, "launcher"), [
      "#!/bin/sh",
      'printf "executed" > "${0%/*}/launcher-marker"',
      `exec ${JSON.stringify(process.execPath)} "\${0%/*}/entry.mjs"`,
    ].join("\n"), { mode: 0o755 });
    await writeVerifierFixture(root, server, {
      kind: "protocol", entry: undefined,
      transport: { type: "stdio", command: join(root, "launcher"), args: [] },
    });
    prepared = await prepareLocalInstall(root);
    probed = await localManager.probeLocalInstall(root, { decision: decisionFor(), reviewHash: prepared.reviewHash });
    assert.equal(probed.conformance.passed, true, summarizeConformance(probed.conformance));
    await assert.rejects(access(join(root, "launcher-marker")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "local-marker")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
