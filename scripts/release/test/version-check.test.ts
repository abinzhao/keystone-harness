/**
 * Version consistency + release-readiness contract. The key behaviours pinned here:
 * matching versions pass, a mismatch fails, a prerelease such as 1.0.0-rc.1 passes
 * on the rc channel (local RC artifact build only), and a stable 1.0.0 is blocked
 * unless explicitly blessed (because the 1.0.0 release gates are not yet met).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkConsistency, evaluateReadiness } from "../version-check.ts";
import type { WorkspacePackage } from "../lib/workspace.ts";

function pkg(name: string, version: string, dir = `packages/${name}`, isPrivate = false): WorkspacePackage {
  return { name, version, private: isPrivate, license: "Apache-2.0", dir, dependencies: {}, devDependencies: {} };
}

test("matching versions are consistent", () => {
  const root = pkg("root", "0.0.0", ".", true);
  const result = checkConsistency(root, [pkg("@keystone/a", "0.0.0"), pkg("@keystone/b", "0.0.0")]);
  assert.equal(result.validSemver, true);
  assert.deepEqual(result.mismatches, []);
});

test("a divergent package version is a hard mismatch", () => {
  const root = pkg("root", "0.0.0", ".", true);
  const result = checkConsistency(root, [pkg("@keystone/a", "0.0.0"), pkg("@keystone/b", "0.1.0")]);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]!.name, "@keystone/b");
});

test("a release read as 1.0.0 without blessing is not ready", () => {
  const root = pkg("root", "1.0.0", ".", false);
  const consistency = checkConsistency(root, [pkg("@keystone/a", "1.0.0")]);
  const report = evaluateReadiness(root, consistency, 1, false);
  const gate = report.gates.find((g) => g.id === "no_1_0_0_without_blessing")!;
  assert.equal(gate.ok, false);
  assert.equal(report.ready, false);
});

test("1.0.0 explicitly blessed clears that gate", () => {
  const root = pkg("root", "1.0.0", ".", false);
  const consistency = checkConsistency(root, [pkg("@keystone/a", "1.0.0")]);
  const report = evaluateReadiness(root, consistency, 1, true);
  const gate = report.gates.find((g) => g.id === "no_1_0_0_without_blessing")!;
  assert.equal(gate.ok, true);
});

test("current 0.0.0 private workspace is internally consistent", () => {
  const root = pkg("root", "0.0.0", ".", true);
  const consistency = checkConsistency(root, [pkg("@keystone/a", "0.0.0")]);
  const report = evaluateReadiness(root, consistency, 1, false);
  // versions in sync, valid semver, stays private, not 1.0.0 -> all gates pass.
  assert.equal(report.ready, true);
});

test("1.0.0-rc.1 passes on the rc channel as a local RC artifact build", () => {
  const root = pkg("root", "1.0.0-rc.1", ".", true);
  const consistency = checkConsistency(root, [pkg("@keystone/a", "1.0.0-rc.1"), pkg("@keystone/b", "1.0.0-rc.1")]);
  const report = evaluateReadiness(root, consistency, 2, false);
  assert.equal(report.channel, "rc");
  assert.equal(report.ready, true);
  // The RC boundary gate is always present and states what the RC does NOT authorize.
  const boundary = report.gates.find((g) => g.id === "rc_boundary")!;
  assert.equal(boundary.ok, true);
  assert.match(boundary.detail, /not a stable release/i);
  // The 1.0.0 blessing gate does not fire for a prerelease.
  const blessing = report.gates.find((g) => g.id === "no_1_0_0_without_blessing")!;
  assert.equal(blessing.ok, true);
});

test("a stable 1.0.0 on the rc channel without blessing still fails after the bump", () => {
  // Even though RC builds pass, graduating to stable 1.0.0 requires --allow-1.0.
  const root = pkg("root", "1.0.0", ".", true);
  const consistency = checkConsistency(root, [pkg("@keystone/a", "1.0.0")]);
  const report = evaluateReadiness(root, consistency, 1, false);
  assert.equal(report.channel, "stable");
  assert.equal(report.ready, false);
});
