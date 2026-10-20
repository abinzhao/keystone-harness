/**
 * The generic verifier-entry shape probe.
 *
 * A manifest that *declares* a verifier export is only a promise. These tests
 * pin down what the probe refuses: an entry that is missing, not a Verifier, or
 * — most importantly — an E1 check that over-claims it can satisfy a required
 * condition (the VF-02 failure mode).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { inspectVerifierEntry, runConformance } from "../src/index.ts";
import type { ExtensionManifest } from "@keystone/schemas";

const BASE_DESCRIPTOR: Record<string, unknown> = {
  kind: "project_rule",
  id: "verifier.fake",
  version: "1.0.0",
  evidenceLevel: "E2",
  canSatisfyRequiredCondition: true,
  independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
};

function verifierWith(descriptorOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptor: { ...BASE_DESCRIPTOR, ...descriptorOverrides },
    run: async () => ({ status: "passed" as const }),
  };
}

function verifierOver(overrides: Record<string, unknown> = {}): unknown {
  return {
    descriptor: { ...BASE_DESCRIPTOR },
    run: async () => ({ status: "passed" as const }),
    ...overrides,
  };
}

const manifest = {
  name: "keystone-verifier-fake",
  version: "1.0.0",
  publisher: "keystone",
  integrity: { algorithm: "sha256", digest: "0".repeat(64) },
  kind: "verifier",
  apiVersion: "1.0",
  capabilities: ["fs.read"],
  sideEffects: [{ kind: "fs_read", scope: "reads" }],
  reversibility: "reversible",
  egressHosts: [],
  credentialHandles: [],
  dataClassification: { reads: "internal", egress: [] },
  produces: { observations: ["x"], evidenceTypes: ["project_rule_check"] },
  execution: { replayable: true, idempotent: true },
  dependencies: [],
  conflicts: [],
  uninstall: "safe",
  entry: { module: "src/index.ts", export: "verifier" },
} as unknown as ExtensionManifest;

test("a well-formed verifier passes the inspection", () => {
  const result = inspectVerifierEntry(verifierOver());
  assert.equal(result.passed, true, result.detail);
});

test("an E1 check that claims it can satisfy a required condition is blocked", () => {
  const result = inspectVerifierEntry(
    verifierOver({
      descriptor: {
        kind: "project_rule",
        id: "verifier.weak",
        version: "1.0.0",
        evidenceLevel: "E1",
        // The exact over-claim VF-02 exists to forbid.
        canSatisfyRequiredCondition: true,
        independence: { mode: "same_process", independentOf: ["builder_loop_model"] },
      },
    }),
  );
  assert.equal(result.passed, false);
  assert.match(result.detail, /E1/);
});

test("a properly-humble E1 check passes (it only may not stand alone)", () => {
  const result = inspectVerifierEntry(
    verifierOver({
      descriptor: {
        kind: "project_rule",
        id: "verifier.weak",
        version: "1.0.0",
        evidenceLevel: "E1",
        canSatisfyRequiredCondition: false,
        independence: { mode: "same_process", independentOf: ["builder_loop_model"] },
      },
    }),
  );
  assert.equal(result.passed, true, result.detail);
});

test("a same-process verifier that claims separation from the process is blocked", () => {
  // The independence over-claim VF-01 exists to forbid: an in-process scan cannot
  // honestly declare itself independent of the process it runs inside.
  const cases: Array<[string, readonly string[]]> = [
    ["builder_loop_process", ["builder_loop_process"]],
    ["builder_loop_workspace", ["builder_loop_workspace"]],
    ["builder_loop_datasource", ["builder_loop_datasource"]],
    ["mixed", ["builder_loop_model", "builder_loop_process"]],
  ];
  for (const [name, independentOf] of cases) {
    const result = inspectVerifierEntry(
      verifierOver({
        descriptor: {
          kind: "project_rule",
          id: "verifier.liar",
          version: "1.0.0",
          evidenceLevel: "E1",
          canSatisfyRequiredCondition: false,
          independence: { mode: "same_process", independentOf },
        },
      }),
    );
    assert.equal(result.passed, false, `expected refusal: ${name}`);
    assert.match(result.detail, /same_process/);
  }
});

test("a separate-process E2 verifier that names the process axis passes", () => {
  const result = inspectVerifierEntry(
    verifierOver({
      descriptor: {
        kind: "custom",
        id: "extension.demo.e2",
        version: "1.0.0",
        evidenceLevel: "E2",
        canSatisfyRequiredCondition: true,
        independence: { mode: "separate_process", independentOf: ["builder_loop_process"] },
      },
    }),
  );
  assert.equal(result.passed, true, result.detail);
});

test("missing, malformed, and dishonest entries are all refused", () => {
  const cases: Array<[string, unknown]> = [
    ["undefined export", undefined],
    ["null export", null],
    ["not an object", 42],
    ["no run()", verifierOver({ run: undefined })],
    ["no descriptor", verifierOver({ descriptor: undefined })],
    ["unknown kind", verifierWith({ kind: "nope" })],
    ["unknown evidence level", verifierWith({ evidenceLevel: "E9" })],
    ["canSatisfy not a boolean", verifierWith({ canSatisfyRequiredCondition: "yes" })],
    ["no independence block", verifierWith({ independence: undefined })],
    ["empty id", verifierWith({ id: "  " })],
  ];
  for (const [name, value] of cases) {
    assert.equal(inspectVerifierEntry(value).passed, false, `expected refusal: ${name}`);
  }
});

test("the probe runs automatically for verifier manifests and gates conformance", async () => {
  // A conforming entry makes the report pass.
  const good = await runConformance({
    manifest,
    integrityVerified: true,
    entryLoader: async () => verifierOver(),
  });
  assert.equal(good.passed, true);
  assert.equal(good.checks.find((c) => c.checkId === "entry.verifier_shape")?.passed, true);

  // A manifest whose entry over-claims fails conformance.
  const bad = await runConformance({
    manifest,
    integrityVerified: true,
    entryLoader: async () =>
      verifierOver({
        descriptor: {
          kind: "project_rule",
          id: "verifier.weak",
          version: "1.0.0",
          evidenceLevel: "E1",
          canSatisfyRequiredCondition: true,
          independence: { mode: "same_process", independentOf: [] },
        },
      }),
  });
  assert.equal(bad.passed, false);
  const shape = bad.checks.find((c) => c.checkId === "entry.verifier_shape");
  assert.equal(shape?.passed, false);
  assert.equal(shape?.blocking, true);

  // A loader that cannot load the entry is also a blocking failure.
  const broken = await runConformance({
    manifest,
    integrityVerified: true,
    entryLoader: async () => {
      throw new Error("module not found");
    },
  });
  assert.equal(broken.passed, false);
  assert.match(broken.checks.find((c) => c.checkId === "entry.verifier_shape")?.detail ?? "", /module not found/);
});

test("non-verifier manifests do not require the entry shape probe", async () => {
  const toolManifest = { ...manifest, kind: "tool", capabilities: ["cmd.exec"] } as unknown as ExtensionManifest;
  const report = await runConformance({
    manifest: toolManifest,
    integrityVerified: true,
    entryLoader: async () => verifierOver(),
  });
  assert.equal(report.checks.find((c) => c.checkId === "entry.verifier_shape"), undefined);
});
