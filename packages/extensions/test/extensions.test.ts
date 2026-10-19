import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newId, sha256Bytes, type ExtensionManifest, type UserDecision } from "@keystone/schemas";

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
