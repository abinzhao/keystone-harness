/**
 * build-info tests pin the reproducibility contract: the fingerprint excludes
 * generatedAt, so the only field that differs between runs on the same tree is the
 * wall-clock timestamp that we explicitly mark as non-deterministic.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assembleBuildInfo, fingerprintInputs, type BuildInfoInputs } from "../build-info.ts";

const FIXED: BuildInfoInputs = {
  nodeVersion: "22.23.2",
  pnpmVersion: "8.15.9",
  packageManagerDeclared: "pnpm@8.15.9",
  lockfileSha256: "deadbeef",
  sourceCommit: "e1a6fec00000000000000000000000000000000",
  sourceDirty: false,
  platform: "darwin",
};

test("fingerprint is stable when only generatedAt changes", () => {
  const first = assembleBuildInfo(FIXED, "2026-10-20T10:00:00.000Z");
  const second = assembleBuildInfo(FIXED, "2026-10-20T10:00:01.500Z");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.generatedAt, second.generatedAt);
});

test("fingerprint changes when a source/environment fact changes", () => {
  const base = fingerprintInputs(FIXED);
  const dirty = fingerprintInputs({ ...FIXED, sourceDirty: true });
  const otherCommit = fingerprintInputs({ ...FIXED, sourceCommit: "f00f" });
  assert.notEqual(base, dirty);
  assert.notEqual(base, otherCommit);
});

test("nonDeterministicFields is explicitly declared", () => {
  const doc = assembleBuildInfo(FIXED, "2026-10-20T10:00:00.000Z");
  assert.deepEqual(doc.nonDeterministicFields, ["generatedAt"]);
});
