/**
 * The lockfile extractor only has to be correct for the pnpm v6 shape we ship. These
 * tests pin that shape and the scoped/non-scoped name splitting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractLockedPackages, splitLockName } from "../lib/lockfile.ts";

test("splitLockName handles scoped and unscoped packages", () => {
  assert.deepEqual(splitLockName("/@types/node@22.20.5"), { name: "@types/node", version: "22.20.5" });
  assert.deepEqual(splitLockName("/typescript@5.9.3"), { name: "typescript", version: "5.9.3" });
});

const SAMPLE_LOCK = `lockfileVersion: '6.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.7.2
        version: 5.9.3

packages:

  /@types/node@22.20.5:
    resolution: {integrity: sha512-types-node}
    dependencies:
      undici-types: 6.21.0
    dev: true

  /typescript@5.9.3:
    resolution: {integrity: sha512-typescript}
    engines: {node: '>=14.17'}
    hasBin: true
    dev: true

  /undici-types@6.21.0:
    resolution: {integrity: sha512-undici}
    dev: true
`;

test("extractLockedPackages resolves identity, integrity and dev flag", () => {
  const pkgs = extractLockedPackages(SAMPLE_LOCK);
  assert.equal(pkgs.length, 3);
  // Sorted by name.
  assert.deepEqual(pkgs.map((p) => p.name), ["@types/node", "typescript", "undici-types"]);

  assert.equal(pkgs[0]!.version, "22.20.5");
  assert.equal(pkgs[0]!.integrity, "sha512-types-node");
  assert.equal(pkgs[0]!.dev, true);

  assert.equal(pkgs[1]!.integrity, "sha512-typescript");
  assert.equal(pkgs[2]!.version, "6.21.0");
});

test("a runtime (non-dev) dependency is flagged scope correctly", () => {
  const lock = `packages:

  /left-pad@1.3.0:
    resolution: {integrity: sha512-leftpad}
`;
  const [pkg] = extractLockedPackages(lock);
  assert.equal(pkg!.name, "left-pad");
  assert.equal(pkg!.version, "1.3.0");
  assert.equal(pkg!.dev, false);
  assert.equal(pkg!.integrity, "sha512-leftpad");
});
