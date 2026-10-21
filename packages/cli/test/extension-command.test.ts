/**
 * End-to-end extension management through the public CLI entry.
 *
 * These drive `runCli` directly against a temporary Keystone home, exactly the
 * way a user would: install a local reference extension, refuse a tampered
 * package, refuse an egress extension until it is confirmed, and prove the
 * registry survives a restart and never widens a capability (PRD PL-01, PL-02).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ExtensionRegistry,
  lowRiskActiveExtensions,
} from "@keystone/extensions";
import { defaultRegistryLocation } from "@keystone/extensions";
import { sha256Bytes } from "@keystone/schemas";

import { runCli, type CliContext } from "../src/index.ts";

type Env = Record<string, string | undefined>;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: readonly string[],
  env: Env,
  options: { isTTY?: boolean; stdin?: AsyncIterable<string> } = {},
): Promise<RunResult> {
  const out = { text: "" };
  const err = { text: "" };
  const context: CliContext = {
    stdout: { write: (chunk: string) => ((out.text += chunk), true) },
    stderr: { write: (chunk: string) => ((err.text += chunk), true) },
    env,
    isTTY: options.isTTY ?? false,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  };
  const code = await runCli(argv, context);
  return { code, stdout: out.text, stderr: err.text };
}

const testDir = dirname(fileURLToPath(import.meta.url));
const referenceExtensionRoot = resolve(testDir, "../../extension-no-debug-statements");

async function makeHome(): Promise<{ home: string; env: Env }> {
  const home = await mkdtemp(join(tmpdir(), "keystone-ext-home-"));
  return { home, env: { KEYSTONE_HOME: home } };
}

/** A minimal local egress tool, digest computed over its real entry bytes. */
async function makeEgressExtension(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "index.ts"),
    [
      "export const egressTool = {",
      "  descriptor: { id: 'egress-tool', version: '1.0.0' },",
      "  run: async () => ({ ok: true }),",
      "};",
      "",
    ].join("\n"),
  );
  const entryBytes = new Uint8Array(await readFile(join(root, "src", "index.ts")));
  await writeFile(
    join(root, "keystone-extension.json"),
    JSON.stringify(
      {
        name: "keystone-egress-telemetry",
        version: "1.0.0",
        publisher: "keystone",
        integrity: { algorithm: "sha256", digest: sha256Bytes(entryBytes) },
        kind: "tool",
        apiVersion: "1.0",
        capabilities: ["net.fetch"],
        sideEffects: [{ kind: "network", scope: "posts telemetry" }],
        reversibility: "reversible",
        egressHosts: ["api.example.com"],
        credentialHandles: [],
        dataClassification: {
          reads: "internal",
          egress: [
            { dataClass: "internal", destination: "api.example.com", purpose: "telemetry" },
          ],
        },
        produces: { observations: ["telemetry"], evidenceTypes: [] },
        execution: { replayable: true, idempotent: true },
        dependencies: [],
        conflicts: [],
        uninstall: "safe",
        entry: { module: "src/index.ts", export: "egressTool" },
        description: "Example egress extension.",
      },
      null,
      2,
    ) + "\n",
  );
}

test("installs and activates the local reference extension through the public entry", async () => {
  const { env } = await makeHome();
  try {
    const inspect = await run(["extension", "inspect", referenceExtensionRoot], env);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, /digest matches the entry on disk/);
    assert.match(inspect.stdout, /conformance : passed/i);

    const install = await run(["extension", "install", referenceExtensionRoot], env);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /installed "keystone-extension-no-debug-statements"/);

    const list1 = await run(["extension", "list"], env);
    assert.match(list1.stdout, /\[registered\] keystone-extension-no-debug-statements/);

    const activate = await run(
      ["extension", "activate", "keystone-extension-no-debug-statements"],
      env,
    );
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /activated "keystone-extension-no-debug-statements" \(active\)/);
  } finally {
    await rm(env.KEYSTONE_HOME ?? "", { recursive: true, force: true });
  }
});

test("refuses a tampered digest and records nothing", async () => {
  const { env } = await makeHome();
  const tampered = await mkdtemp(join(tmpdir(), "keystone-tampered-"));
  try {
    // Copy the reference extension but alter the entry after the manifest was written.
    const manifest = await readFile(join(referenceExtensionRoot, "keystone-extension.json"), "utf8");
    await writeFile(join(tampered, "keystone-extension.json"), manifest);
    await mkdir(join(tampered, "src"), { recursive: true });
    await writeFile(
      join(tampered, "src", "index.ts"),
      (await readFile(join(referenceExtensionRoot, "src", "index.ts"), "utf8")) +
        "\n// tampered after the manifest was written\n",
    );

    const install = await run(["extension", "install", tampered], env);
    assert.equal(install.code, 1);
    assert.match(install.stderr, /digest does not match/i);

    // Nothing was registered: a refused install leaves no audit row.
    const list = await run(["extension", "list"], env);
    assert.match(list.stdout, /none installed/);
  } finally {
    await rm(env.KEYSTONE_HOME ?? "", { recursive: true, force: true });
    await rm(tampered, { recursive: true, force: true });
  }
});

test("refuses egress activation until the user explicitly confirms", async () => {
  const { env } = await makeHome();
  const egress = await mkdtemp(join(tmpdir(), "keystone-egress-"));
  try {
    await makeEgressExtension(egress);

    // Installing an egress extension without confirmation is refused.
    const refusedInstall = await run(["extension", "install", egress], env);
    assert.equal(refusedInstall.code, 1);
    assert.match(refusedInstall.stderr, /did not confirm the egress risk/);

    // With --yes it is admitted, but stays inert until activated.
    const confirmedInstall = await run(["extension", "install", egress, "--yes"], env);
    assert.equal(confirmedInstall.code, 0, confirmedInstall.stderr);

    // Activating without confirmation is refused.
    const refusedActivate = await run(
      ["extension", "activate", "keystone-egress-telemetry"],
      env,
    );
    assert.equal(refusedActivate.code, 1);
    assert.match(refusedActivate.stderr, /did not confirm the egress risk/);

    // An explicit --yes activates it.
    const activate = await run(
      ["extension", "activate", "keystone-egress-telemetry", "--yes"],
      env,
    );
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /activated "keystone-egress-telemetry" \(active\)/);
  } finally {
    await rm(env.KEYSTONE_HOME ?? "", { recursive: true, force: true });
    await rm(egress, { recursive: true, force: true });
  }
});

test("the registry persists across reloads and never widens a capability", async () => {
  const { home, env } = await makeHome();
  const egress = await mkdtemp(join(tmpdir(), "keystone-egress-"));
  try {
    await makeEgressExtension(egress);
    // Install + activate the low-risk reference extension.
    await run(["extension", "install", referenceExtensionRoot], env);
    await run(["extension", "activate", "keystone-extension-no-debug-statements"], env);
    // Install + activate the egress extension too.
    await run(["extension", "install", egress, "--yes"], env);
    await run(["extension", "activate", "keystone-egress-telemetry", "--yes"], env);

    // A brand-new registry instance (simulating a restart) sees the same state.
    const reloaded = new ExtensionRegistry(defaultRegistryLocation(home));
    await reloaded.load();
    assert.equal(reloaded.get("keystone-extension-no-debug-statements")?.status, "active");
    assert.equal(reloaded.get("keystone-egress-telemetry")?.status, "active");

    // The registered manifest is the declared set — activation did not add any
    // capability. The reference extension asks for exactly fs.read, nothing more.
    const ref = reloaded.get("keystone-extension-no-debug-statements");
    assert.deepEqual(ref?.manifest.capabilities, ["fs.read"]);

    // The read-only workbench projection surfaces only the low-risk extension:
    // the egress one is visible to the registry but never offered as safe.
    const views = lowRiskActiveExtensions(reloaded.list());
    const names = views.map((view) => view.name);
    assert.ok(names.includes("keystone-extension-no-debug-statements"));
    assert.ok(!names.includes("keystone-egress-telemetry"));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(egress, { recursive: true, force: true });
  }
});
