/**
 * Reference extension exercised the way a host would exercise it.
 *
 * The sequence matters and is the same one a user goes through: read the
 * declaration, verify the digest, run the conformance kit (including the generic
 * verifier-entry shape probe), pass the activation gate, and only then run the
 * verifier against a project. The pure checker and the runnable CLI are tested
 * directly too, since they are the reusable half of the scenario.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ExtensionRegistry,
  canActivate,
  checkDeclarations,
  describeInstallReview,
  inspectVerifierEntry,
  reachesOutside,
  runConformance,
} from "@keystone/extensions";
import { resolveKeystonePaths } from "@keystone/kernel";
import type { OutcomeContract } from "@keystone/schemas";
import type { VerifierContext } from "@keystone/verifiers";

import {
  REFERENCE_EXTENSION,
  buildManifest,
  catalogParityHolds,
  checkCatalogParity,
  extractPlaceholders,
  loadDeclaration,
  localizationParityE2Verifier,
  localizationPlaceholdersVerifier,
  runCli,
} from "../src/index.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Load the real entry export the way a host's conformance probe would. */
async function loadEntry(modulePath: string, exportName: string): Promise<unknown> {
  const mod = await import(new URL(modulePath, `file://${packageRoot}/`).href);
  return (mod as Record<string, unknown>)[exportName];
}

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

const EN = {
  greeting: "Hello {name}, you have {count} messages",
  farewell: "Goodbye",
  cart: "Your total is {{total}}",
};

test("extractPlaceholders reads both {name} and {{name}} forms", () => {
  assert.deepEqual([...extractPlaceholders("Hello {name}, {count}")].sort(), ["count", "name"]);
  assert.deepEqual([...extractPlaceholders("Total {{total}}")], ["total"]);
  // Reordering is fine; parity is about the set, not the order.
  assert.deepEqual(
    [...extractPlaceholders("{count} {name}")].sort(),
    ["count", "name"],
  );
  assert.deepEqual([...extractPlaceholders("no placeholders here")], []);
});

test("the pure checker finds dropped, extra, missing and orphan placeholders", () => {
  // Perfect translation: same set, reordered, one message with none.
  assert.equal(catalogParityHolds(EN, {
    greeting: "你好 {name}，你有 {count} 条消息",
    farewell: "再见",
    cart: "总计 {{total}}",
  }), true);

  // Dropped placeholder.
  const dropped = checkCatalogParity(EN, {
    greeting: "你好 {name}",
    farewell: "再见",
    cart: "总计 {{total}}",
  });
  assert.ok(dropped.some((f) => f.kind === "dropped_placeholder" && f.placeholder === "count"));

  // Invented placeholder.
  const extra = checkCatalogParity(EN, {
    greeting: "你好 {name}，你有 {count} 条来自 {sender} 的消息",
    farewell: "再见",
    cart: "总计 {{total}}",
  });
  assert.ok(extra.some((f) => f.kind === "extra_placeholder" && f.placeholder === "sender"));

  // Untranslated key.
  const missing = checkCatalogParity(EN, {
    greeting: "你好 {name}，你有 {count} 条消息",
    cart: "总计 {{total}}",
  });
  assert.ok(missing.some((f) => f.kind === "missing_translation" && f.key === "farewell"));

  // Orphan translation for a removed source key.
  const orphan = checkCatalogParity(EN, {
    greeting: "你好 {name}，你有 {count} 条消息",
    farewell: "再见",
    cart: "总计 {{total}}",
    removed: "这个键源里没有",
  });
  assert.ok(orphan.some((f) => f.kind === "orphan_translation" && f.key === "removed"));
});

test("the runnable CLI exits 0 on parity and 1 on a finding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-loc-cli-"));
  try {
    await writeFile(join(dir, "en.json"), JSON.stringify(EN));
    await writeFile(join(dir, "zh-ok.json"), JSON.stringify({
      greeting: "你好 {name}，你有 {count} 条消息",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));
    await writeFile(join(dir, "zh-bad.json"), JSON.stringify({
      greeting: "你好 {name}",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));

    const ok = await runCli([join(dir, "en.json"), join(dir, "zh-ok.json")]);
    assert.equal(ok, 0);

    const bad = await runCli([join(dir, "en.json"), join(dir, "zh-bad.json")]);
    assert.equal(bad, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the E1 adapter passes on parity and fails on a dropped placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-loc-adapter-"));
  try {
    await mkdir(join(root, "locales"), { recursive: true });
    await writeFile(join(root, "locales", "en.json"), JSON.stringify(EN));
    await writeFile(join(root, "locales", "zh.json"), JSON.stringify({
      greeting: "你好 {name}",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));

    const failed = await localizationPlaceholdersVerifier.run(contextFor(root, ["locales/zh.json"]));
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /placeholder parity issue/);

    await writeFile(join(root, "locales", "zh.json"), JSON.stringify({
      greeting: "你好 {name}，你有 {count} 条消息",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));
    const passed = await localizationPlaceholdersVerifier.run(contextFor(root, ["locales/zh.json"]));
    assert.equal(passed.status, "passed");
    assert.equal(passed.incomplete, undefined);

    // Honest E1: it cannot stand alone for a required condition.
    assert.equal(localizationPlaceholdersVerifier.descriptor.evidenceLevel, "E1");
    assert.equal(localizationPlaceholdersVerifier.descriptor.canSatisfyRequiredCondition, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the E1 adapter says when it cannot check rather than passing silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-loc-blocked-"));
  try {
    // No source catalog at all: blocked, not a clean pass.
    const blocked = await localizationPlaceholdersVerifier.run(contextFor(root, ["locales/zh.json"]));
    assert.equal(blocked.status, "blocked");
    assert.match(String(blocked.incomplete?.[0]), /source catalog/);

    // A source catalog exists, but nothing locale-shaped changed.
    await mkdir(join(root, "locales"), { recursive: true });
    await writeFile(join(root, "locales", "en.json"), JSON.stringify(EN));
    const noChange = await localizationPlaceholdersVerifier.run(contextFor(root, ["README.md"]));
    assert.equal(noChange.status, "passed");
    assert.deepEqual(noChange.incomplete, ["no changed locale files were observed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the E2 verifier runs the parity checker in a child process and is honest about it", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-loc-e2-"));
  try {
    await mkdir(join(root, "locales"), { recursive: true });
    await writeFile(join(root, "locales", "en.json"), JSON.stringify(EN));
    await writeFile(join(root, "locales", "zh.json"), JSON.stringify({
      greeting: "你好 {name}",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));

    // The condition names the source/target the checker must compare, exactly as
    // the localization ContractProposer writes them.
    const condition = {
      conditionId: "cond.placeholder_parity",
      description: "parity",
      verifier: {
        kind: "custom" as const,
        id: localizationParityE2Verifier.descriptor.id,
        version: localizationParityE2Verifier.descriptor.version,
        params: { source: "locales/en.json", target: "locales/zh.json" },
      },
      minEvidenceLevel: "E2" as const,
      requiresIndependence: false,
      required: true,
    };
    const ctx: VerifierContext = {
      ...contextFor(root, ["locales/zh.json"]),
      conditions: [condition],
    };

    // Baseline catalog drops {count}: the child-process check fails.
    const failed = await localizationParityE2Verifier.run(ctx);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.command?.includes("node") || (failed.command ?? "").length > 0);

    await writeFile(join(root, "locales", "zh.json"), JSON.stringify({
      greeting: "你好 {name}，你有 {count} 条消息",
      farewell: "再见",
      cart: "总计 {{total}}",
    }));
    const passed = await localizationParityE2Verifier.run(ctx);
    assert.equal(passed.status, "passed");
    assert.equal(passed.exitCode, 0);

    // Honest E2: a separate process, able to stand alone for a required condition.
    assert.equal(localizationParityE2Verifier.descriptor.evidenceLevel, "E2");
    assert.equal(localizationParityE2Verifier.descriptor.canSatisfyRequiredCondition, true);
    assert.equal(localizationParityE2Verifier.descriptor.independence.mode, "separate_process");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the declaration is minimal, self-consistent and needs no network", async () => {
  const { manifest, integrityVerified } = await loadDeclaration(packageRoot);
  assert.equal(integrityVerified, true);
  assert.equal(manifest.name, REFERENCE_EXTENSION.name);
  assert.deepEqual(manifest.capabilities, ["fs.read"]);
  assert.deepEqual(manifest.egressHosts, []);
  assert.deepEqual(manifest.dataClassification.egress, []);
  assert.equal(reachesOutside(manifest), false);

  const checks = checkDeclarations(manifest);
  assert.ok(
    checks.every((check) => check.passed || !check.blocking),
    `declarations must be consistent: ${JSON.stringify(checks.filter((c) => !c.passed))}`,
  );

  const tampered = buildManifest(new TextEncoder().encode("not the entry module"));
  assert.notEqual(tampered.integrity.digest, manifest.integrity.digest);
});

test("conformance passes on the real entry and the shape probe gates activation", async () => {
  const { manifest } = await loadDeclaration(packageRoot);

  // Without a host-supplied entry loader, no shape probe runs (backwards compatible).
  const shallow = await runConformance({ manifest, integrityVerified: true });
  assert.equal(shallow.passed, true);
  assert.equal(
    shallow.checks.find((c) => c.checkId === "entry.verifier_shape"),
    undefined,
  );

  // With a loader, the kit loads the real export and inspects it.
  const report = await runConformance({
    manifest,
    integrityVerified: true,
    entryLoader: loadEntry,
  });
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.passed)));
  const shape = report.checks.find((c) => c.checkId === "entry.verifier_shape");
  assert.ok(shape?.passed, "the real entry must pass the generic shape probe");

  // The loaded entry is, by construction, a well-formed verifier.
  const loaded = await loadEntry(manifest.entry!.module, manifest.entry!.export);
  assert.equal(inspectVerifierEntry(loaded).passed, true);

  // Activation still requires conformance, then it opens.
  assert.equal(canActivate({ manifest, integrityVerified: true }).allowed, false);
  const gate = canActivate({ manifest, integrityVerified: true, conformance: report });
  assert.equal(gate.allowed, true);
  assert.equal(canActivate({ manifest, integrityVerified: false, conformance: report }).allowed, false);

  const review = describeInstallReview(manifest);
  assert.deepEqual(review.dataEgress, ["nothing leaves the machine"]);
  assert.deepEqual(review.canDo, ["fs.read"]);
});

test("the registry accepts the reference extension end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keystone-loc-registry-"));
  try {
    const registry = new ExtensionRegistry({ registryFile: join(dir, "extensions.json") });
    await registry.load();

    const { manifest, integrityVerified } = await loadDeclaration(packageRoot);
    const conformance = await runConformance({ manifest, integrityVerified, entryLoader: loadEntry });

    await registry.register({
      manifest,
      source: { kind: "local_path", locator: packageRoot },
      integrityVerified,
      conformance,
    });

    const activated = await registry.activate(manifest.name);
    assert.equal(activated.status, "active");

    const reloaded = new ExtensionRegistry({ registryFile: join(dir, "extensions.json") });
    await reloaded.load();
    assert.equal(reloaded.get(manifest.name)?.status, "active");
    assert.equal(reloaded.active().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
