/**
 * SBOM generator tests. They build a tiny fake workspace on disk and assert the
 * component list, the offline/deterministic guarantees, and the purl format.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSbom, renderSbom } from "../sbom.ts";

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keystone-sbom-"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", version: "0.1.0", private: true, license: "Apache-2.0" }, null, 2),
  );
  mkdirSync(path.join(root, "packages", "alpha"), { recursive: true });
  writeFileSync(
    path.join(root, "packages", "alpha", "package.json"),
    JSON.stringify({ name: "@demo/alpha", version: "0.1.0", license: "MIT" }),
  );
  mkdirSync(path.join(root, "packages", "beta"), { recursive: true });
  writeFileSync(
    path.join(root, "packages", "beta", "package.json"),
    JSON.stringify({ name: "@demo/beta", version: "0.1.0" }),
  );
  writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    `packages:

  /typescript@5.9.3:
    resolution: {integrity: sha512-ts}
    dev: true

  /left-pad@1.3.0:
    resolution: {integrity: sha512-lp}
`,
  );
  return root;
}

test("SBOM lists workspace packages plus resolved third-party deps", () => {
  const root = makeFixture();
  try {
    const doc = buildSbom(root, readLock(root));
    assert.equal(doc.workspaceVersion, "0.1.0");
    assert.equal(doc.offline, true);
    assert.equal(doc.componentCount, doc.components.length);

    const workspaces = doc.components.filter((c) => c.scope === "workspace").map((c) => c.name);
    assert.deepEqual(workspaces.sort(), ["@demo/alpha", "@demo/beta"]);

    const typescript = doc.components.find((c) => c.name === "typescript");
    assert.equal(typescript!.scope, "dev");
    assert.equal(typescript!.purl, "pkg:npm/typescript@5.9.3");
    assert.equal(typescript!.integrity, "sha512-ts");

    const leftPad = doc.components.find((c) => c.name === "left-pad");
    assert.equal(leftPad!.scope, "runtime");
    assert.equal(leftPad!.purl, "pkg:npm/left-pad@1.3.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SBOM output has no timestamp and is byte-deterministic", () => {
  const root = makeFixture();
  try {
    const a = renderSbom(buildSbom(root, readLock(root)));
    const b = renderSbom(buildSbom(root, readLock(root)));
    assert.equal(a, b);
    assert.ok(!/20\d\d-\d\d-\d\d/.test(a), "SBOM must not embed a generated date");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readLock(root: string): string {
  return readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
}
