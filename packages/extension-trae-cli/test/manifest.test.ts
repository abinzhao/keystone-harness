import assert from "node:assert/strict";
import test from "node:test";
import { createTraeCliManifest } from "../src/manifest.ts";
import { extensionManifestSchema } from "../../schemas/src/schemas/extension.ts";

test("manifest requires measured integrity and explicit hosts, declares effects and never credentials or evidence", () => {
  const manifest = extensionManifestSchema.parse(createTraeCliManifest({
    digest: "a".repeat(64), egressHosts: ["api.example.com"],
  }));
  assert.equal(manifest.kind, "model");
  assert.deepEqual(manifest.capabilities, ["model.invoke", "cmd.exec"]);
  assert.deepEqual(manifest.egressHosts, ["api.example.com"]);
  assert.deepEqual(manifest.credentialHandles, []);
  assert.deepEqual(manifest.dataClassification.egress.map((rule) => rule.dataClass), ["public", "internal", "sensitive"]);
  assert.deepEqual(manifest.produces.evidenceTypes, []);
  assert.equal(manifest.execution.replayable, false);
  assert.deepEqual(manifest.sideEffects.map((effect) => effect.kind), ["fs_read", "fs_write", "process_spawn", "network"]);
  for (const input of [{ digest: "", egressHosts: ["api.example.com"] },
    { digest: "0".repeat(64), egressHosts: [] }, { digest: "a".repeat(64), egressHosts: ["localhost"] }]) {
    assert.throws(() => createTraeCliManifest(input), { code: "configuration" });
  }
});
