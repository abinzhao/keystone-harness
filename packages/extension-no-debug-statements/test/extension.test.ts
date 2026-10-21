/**
 * A reference extension, exercised the way a host would exercise it.
 *
 * The sequence matters and is the same one a user goes through: read the
 * declaration, verify the digest, run the conformance kit, pass the activation
 * gate, and only then run the verifier against a project.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ExtensionRegistry,
  canActivate,
  capabilityCeiling,
  checkDeclarations,
  describeInstallReview,
  reachesOutside,
  readLocalPackage,
  runConformance,
} from "@keystone/extensions";
import { resolveKeystonePaths } from "@keystone/kernel";
import type { OutcomeContract } from "@keystone/schemas";
import type { VerifierContext } from "@keystone/verifiers";

import {
  REFERENCE_EXTENSION,
  buildManifest,
  loadDeclaration,
  noDebugStatementsVerifier,
  scanForDebugStatements,
} from "../src/index.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function contextFor(rootPath: string, changedPaths: readonly string[]): VerifierContext {
  return {
    rootPath,
    taskId: "task_01M59N02E9Z2FJ4NV2BHR59Z5H",
    branchId: "branch_01M59N02E9Z2FJ4NV2BHR59Z5H",
    paths: resolveKeystonePaths(join(rootPath, ".keystone-home")),
    contract: { scope: { include: [], exclude: [], unknown: [] } } as unknown as OutcomeContract,
    conditions: [],
    changedPaths: [...changedPaths],
  };
}

test("the declaration is minimal, self-consistent and needs no network", async () => {
  const { manifest, integrityVerified } = await loadDeclaration(packageRoot);
  assert.equal(integrityVerified, true);
  assert.equal(manifest.name, REFERENCE_EXTENSION.name);
  assert.deepEqual(manifest.capabilities, ["fs.read"]);
  assert.deepEqual(manifest.egressHosts, []);
  assert.deepEqual(manifest.dataClassification.egress, []);
  assert.equal(reachesOutside(manifest), false, "the reference extension must not reach outside");

  const checks = checkDeclarations(manifest);
  assert.ok(
    checks.every((check) => check.passed || !check.blocking),
    `declarations must be consistent: ${JSON.stringify(checks.filter((c) => !c.passed))}`,
  );

  // The digest describes real bytes: a different file must not verify.
  const tampered = buildManifest(new TextEncoder().encode("not the entry module"));
  assert.notEqual(tampered.integrity.digest, manifest.integrity.digest);
});

test("conformance passes on the real declaration and gates activation", async () => {
  const { manifest } = await loadDeclaration(packageRoot);

  const report = await runConformance({ manifest, integrityVerified: true });
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.passed)));

  // Without a conformance run there is nothing to activate on.
  assert.equal(canActivate({ manifest, integrityVerified: true }).allowed, false);

  const gate = canActivate({ manifest, integrityVerified: true, conformance: report });
  assert.equal(gate.allowed, true);
  assert.equal(gate.requiresConfirmation, false);

  // An unverified digest must block regardless of a passing report.
  assert.equal(
    canActivate({ manifest, integrityVerified: false, conformance: report }).allowed,
    false,
  );

  // The install review has to be readable before anyone agrees to it.
  const review = describeInstallReview(manifest);
  assert.deepEqual(review.dataEgress, ["nothing leaves the machine"]);
  assert.deepEqual(review.canDo, ["fs.read"]);

  // A ceiling can only shrink what was declared.
  assert.deepEqual(capabilityCeiling(manifest, []), []);
  assert.deepEqual(capabilityCeiling(manifest, ["fs.read", "cmd.exec"]), ["fs.read"]);
});

test("the verifier fails on debug statements it was supposed to catch", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-refext-"));
  try {
    await writeFile(
      join(root, "service.ts"),
      [
        "export function handle(): number {",
        "  console.log('debugging');",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );

    const failed = await noDebugStatementsVerifier.run(contextFor(root, ["service.ts"]));
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /service\.ts:2 console\.log/);
    // E1 evidence cannot stand alone, and the descriptor must say so.
    assert.equal(noDebugStatementsVerifier.descriptor.canSatisfyRequiredCondition, false);
    assert.equal(noDebugStatementsVerifier.descriptor.evidenceLevel, "E1");

    await writeFile(
      join(root, "service.ts"),
      ["export function handle(): number {", "  return 1;", "}", ""].join("\n"),
    );
    const passed = await noDebugStatementsVerifier.run(contextFor(root, ["service.ts"]));
    assert.equal(passed.status, "passed");
    assert.equal(passed.incomplete, undefined);

    // A `debugger` statement is caught too, and comments are not.
    assert.deepEqual(
      scanForDebugStatements("a.ts", "// console.log(1)\ndebugger;\n").map((f) => f.kind),
      ["debugger"],
    );

    // Test files are exempt: a test that prints while diagnosing is normal.
    assert.deepEqual(scanForDebugStatements("test/a.test.ts", "console.log(1);"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the verifier reports what it could not check instead of passing silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-refext-"));
  try {
    const noChanges = await noDebugStatementsVerifier.run(contextFor(root, []));
    assert.equal(noChanges.status, "passed");
    assert.deepEqual(noChanges.incomplete, ["no changed paths were observed"]);

    // A deleted or unreadable file must be named, not treated as clean.
    const missing = await noDebugStatementsVerifier.run(contextFor(root, ["gone.ts"]));
    assert.equal(missing.status, "passed");
    assert.match(String(missing.incomplete?.[0]), /could not read: gone\.ts/);

    // A binary or unknown extension is not scanned at all.
    const skipped = await noDebugStatementsVerifier.run(contextFor(root, ["logo.png"]));
    assert.equal(skipped.status, "passed");
    assert.equal(skipped.incomplete, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the registry accepts the reference extension end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-refext-registry-"));
  try {
    const registry = new ExtensionRegistry({ registryFile: join(dir, "extensions.json") });
    await registry.load();

    const { manifest, integrityVerified } = await loadDeclaration(packageRoot);
    const conformance = await runConformance({ manifest, integrityVerified });

    await registry.register({
      manifest,
      source: { kind: "local_path", locator: packageRoot },
      integrityVerified,
      conformance,
    });

    const activated = await registry.activate(manifest.name);
    assert.equal(activated.status, "active");
    assert.match(activated.extensionId, /^ext_/);

    // The registry survives a restart, because the state was persisted first.
    const reloaded = new ExtensionRegistry({ registryFile: join(dir, "extensions.json") });
    await reloaded.load();
    assert.equal(reloaded.get(manifest.name)?.status, "active");
    assert.equal(reloaded.active().length, 1);

    // Isolation has a named reason, so the task's checkpoint can explain it.
    const isolated = await reloaded.isolate(
      manifest.name,
      "manifest_violation",
      "attempted to read outside the leased paths",
    );
    assert.equal(isolated.status, "isolated");
    assert.equal(reloaded.unexplained().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed keystone-extension.json matches the built manifest and real entry bytes", async () => {
  const { manifest, integrityVerified } = await loadDeclaration(packageRoot);
  assert.equal(integrityVerified, true);

  const committed = JSON.parse(
    await readFile(join(packageRoot, "keystone-extension.json"), "utf8"),
  ) as { integrity: { digest: string }; name: string; entry: { module: string } };

  // The committed manifest is what `keystone extension install <path>` reads; it
  // must describe the same bytes the authoring builder hashes, or the public
  // entry would refuse a package that is supposed to be the worked example.
  assert.equal(committed.name, manifest.name);
  assert.equal(committed.entry?.module, manifest.entry?.module);
  assert.equal(committed.integrity.digest, manifest.integrity.digest);

  // Loading the committed manifest through the public local-package reader must
  // verify against the real entry on disk.
  const read = await readLocalPackage(packageRoot);
  assert.equal(read.integrityVerified, true);
});
