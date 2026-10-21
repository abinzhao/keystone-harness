import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, sha256Bytes } from "../../../packages/schemas/src/index.ts";
import { checkReleaseReadiness, LOCAL_GATES, STABLE_GATES } from "../readiness.ts";

const now = new Date("2026-10-21T12:00:00.000Z");
const binding = { releaseVersion: "1.0.0-rc.1", sourceCommit: "a".repeat(40), sourceDigest: "b".repeat(64),
  artifactDigest: "c".repeat(64) };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "keystone-readiness-"));
  await mkdir(join(root, "artifacts"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}
function report(gateId: string, details: Record<string, unknown> = {}) {
  return { version: "keystone.release-evidence/1", gateId, status: "passed", ...binding,
    observedAt: now.toISOString(), details };
}
async function store(root: string, gateId: string, payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const sha256 = sha256Bytes(bytes);
  await writeFile(join(root, "artifacts", `${sha256}.json`), bytes);
  return { gateId, status: "passed", evidence: { path: `artifacts/${sha256}.json`, sha256 } };
}
function input(gates: unknown[] = []) { return { version: "keystone.release-readiness/1", ...binding, gates }; }
const commandDetails = { command: ["node", "--test"], exitCode: 0, checks: 2, failures: 0 };

test("no gate passes without evidence; unknown and duplicate gate claims are rejected", async () => {
  const { root, dispose } = await fixture();
  try {
    const card = await checkReleaseReadiness(input([{ gateId: "macos_signing", status: "passed" }]), { root, now });
    assert.equal(card.localReady, false);
    assert.equal(card.stableReady, false);
    assert.equal(card.gates.length, STABLE_GATES.length);
    assert.equal(card.gates.find((gate) => gate.gateId === "macos_signing")?.status, "missing");
    for (const gate of card.gates) assert.notEqual(gate.status, "passed");
    await assert.rejects(checkReleaseReadiness(input([{ gateId: "unknown", status: "passed" }]), { root, now }), /gate/);
    await assert.rejects(checkReleaseReadiness(input([{ gateId: "tests", status: "failed" }, { gateId: "tests", status: "passed" }]), { root, now }), /duplicate/);
  } finally { await dispose(); }
});

test("local command evidence does not imply external release readiness", async () => {
  const { root, dispose } = await fixture();
  try {
    const gates = [];
    for (const gate of LOCAL_GATES) {
      const details = gate === "evaluation" ? {
        suiteVersion: "keystone.evaluation/1", repetitions: 2, modes: ["minimal", "standard"],
        inputFingerprint: contentHash("fixed"), runs: 24, falseCompletions: 0, scopeEscapes: 0,
        infrastructureFailures: 0, replayInconsistent: 0, missingMetrics: ["live_provider_quality"],
      } : commandDetails;
      gates.push(await store(root, gate, report(gate, details)));
    }
    const card = await checkReleaseReadiness(input(gates), { root, now });
    assert.equal(card.localReady, true);
    assert.equal(card.stableReady, false);
    for (const gate of ["macos_signing", "notarization", "live_provider", "windows", "hosted_ci"]) {
      assert.equal(card.gates.find((item) => item.gateId === gate)?.status, "missing");
    }
  } finally { await dispose(); }
});

test("tampering, foreign source, stale evidence and nonportable paths cannot satisfy a gate", async () => {
  const { root, dispose } = await fixture();
  try {
    const valid = await store(root, "tests", report("tests", commandDetails));
    await writeFile(join(root, valid.evidence.path), "{}");
    assert.equal((await checkReleaseReadiness(input([valid]), { root, now })).gates.find((gate) => gate.gateId === "tests")?.status, "invalid");
    for (const changed of [
      { sourceDigest: "d".repeat(64) }, { artifactDigest: "d".repeat(64) }, { gateId: "typecheck" },
      { observedAt: "2020-01-01T00:00:00.000Z" }, { observedAt: "2027-01-01T00:00:00.000Z" },
    ]) {
      const gate = await store(root, "tests", { ...report("tests", commandDetails), ...changed });
      assert.equal((await checkReleaseReadiness(input([gate]), { root, now })).gates.find((item) => item.gateId === "tests")?.status, "invalid");
    }
    const escaped = { ...valid, evidence: { ...valid.evidence, path: "../elsewhere.json" } };
    assert.equal((await checkReleaseReadiness(input([escaped]), { root, now })).gates.find((gate) => gate.gateId === "tests")?.status, "invalid");
    const linked = await store(root, "tests", report("tests", commandDetails));
    await rm(join(root, linked.evidence.path));
    await symlink(join(root, "missing.json"), join(root, linked.evidence.path));
    assert.equal((await checkReleaseReadiness(input([linked]), { root, now })).gates.find((gate) => gate.gateId === "tests")?.status, "invalid");
  } finally { await dispose(); }
});

test("external gates require their own concrete evidence, not scripted or local command claims", async () => {
  const { root, dispose } = await fixture();
  try {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["macos_signing", commandDetails, false],
      ["macos_signing", { ...commandDetails, platform: "darwin", identity: "-", teamId: "TEAM123", verified: true }, false],
      ["macos_signing", { ...commandDetails, platform: "darwin", identity: "Developer ID Application: Example", teamId: "TEAM123", verified: true }, true],
      ["notarization", { status: "Accepted", ticketId: "ticket", teamId: "TEAM123", stapled: true, platform: "darwin" }, true],
      ["live_provider", { provider: "scripted", network: false, checks: 1, failures: 0, tokens: 0 }, false],
      ["live_provider", { provider: "openai-compatible", network: true, endpointHost: "model.example.invalid", checks: 1, failures: 0, tokens: 17 }, true],
      ["windows", { ...commandDetails, platform: "darwin" }, false],
      ["windows", { ...commandDetails, platform: "win32", nativeLaunch: true }, true],
      ["hosted_ci", { ...commandDetails, hosted: false, runId: "local" }, false],
      ["hosted_ci", { ...commandDetails, hosted: true, runId: "123", runUrl: "https://ci.example.invalid/runs/123", sourceCommit: binding.sourceCommit }, true],
    ];
    for (const [gateId, details, passes] of cases) {
      const gate = await store(root, gateId, report(gateId, details));
      const card = await checkReleaseReadiness(input([gate]), { root, now });
      assert.equal(card.gates.find((item) => item.gateId === gateId)?.status, passes ? "passed" : "invalid", gateId);
      assert.equal(card.stableReady, false);
    }
  } finally { await dispose(); }
});
