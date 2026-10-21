/**
 * Workspace version bumper tests. They pin the authoritative contract: the root
 * and every packages/* package.json move to the same version, dependencies and
 * other fields survive untouched, and an invalid version is rejected before any
 * file is written.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bumpWorkspace, bumpablePackageJsonFiles, isValidReleaseVersion, isPrereleaseVersion } from "../bump-version.ts";

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keystone-bump-"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", version: "0.0.0", private: true, packageManager: "pnpm@8.15.9" }, null, 2) + "\n",
  );
  mkdirSync(path.join(root, "packages", "alpha"), { recursive: true });
  writeFileSync(
    path.join(root, "packages", "alpha", "package.json"),
    JSON.stringify({ name: "@demo/alpha", version: "0.0.0", dependencies: { "@demo/beta": "workspace:*" } }, null, 2) + "\n",
  );
  mkdirSync(path.join(root, "packages", "beta"), { recursive: true });
  writeFileSync(
    path.join(root, "packages", "beta", "package.json"),
    JSON.stringify({ name: "@demo/beta", version: "0.0.0" }, null, 2) + "\n",
  );
  return root;
}

test("bumpable files are root + one per packages/* package.json", () => {
  const root = makeFixture();
  try {
    const files = bumpablePackageJsonFiles(root).map((f) => path.relative(root, f));
    assert.deepEqual(files, [
      "package.json",
      path.join("packages", "alpha", "package.json"),
      path.join("packages", "beta", "package.json"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bump moves every package.json to the RC version and preserves other fields", () => {
  const root = makeFixture();
  try {
    const changes = bumpWorkspace(root, "1.0.0-rc.1");
    assert.equal(changes.length, 3);

    const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(rootPkg.version, "1.0.0-rc.1");
    assert.equal(rootPkg.private, true);
    assert.equal(rootPkg.packageManager, "pnpm@8.15.9");

    const alpha = JSON.parse(readFileSync(path.join(root, "packages", "alpha", "package.json"), "utf8"));
    assert.equal(alpha.version, "1.0.0-rc.1");
    // workspace dependency specifier must survive the bump untouched.
    assert.deepEqual(alpha.dependencies, { "@demo/beta": "workspace:*" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bump is idempotent when the version is already current", () => {
  const root = makeFixture();
  try {
    bumpWorkspace(root, "1.0.0-rc.1");
    const alphaPath = path.join(root, "packages", "alpha", "package.json");
    const before = readFileSync(alphaPath, "utf8");
    bumpWorkspace(root, "1.0.0-rc.1");
    assert.equal(readFileSync(alphaPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid versions are rejected and never written", () => {
  const root = makeFixture();
  try {
    for (const bad of ["v1.0.0", "1.0", "latest", "1.0.0+build@", ""]) {
      assert.throws(() => bumpWorkspace(root, bad as string), /invalid release version/);
    }
    // Root file untouched.
    const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(rootPkg.version, "0.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version validation distinguishes RC prereleases from stable releases", () => {
  assert.equal(isValidReleaseVersion("1.0.0-rc.1"), true);
  assert.equal(isValidReleaseVersion("1.0.0"), true);
  assert.equal(isValidReleaseVersion("v1.0.0"), false);
  assert.equal(isPrereleaseVersion("1.0.0-rc.1"), true);
  assert.equal(isPrereleaseVersion("1.0.0"), false);
});
