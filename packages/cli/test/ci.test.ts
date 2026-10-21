/**
 * E2E tests for `keystone ci` — the headless automation surface.
 *
 * These drive `runCli` directly against a temp Keystone home and a real Git
 * fixture, using the offline scripted model so the whole run is deterministic and
 * needs no network. They pin the two things a CI runner depends on:
 *
 *   1. the process exit code for each terminal task state, and
 *   2. the single stable JSON object on stdout (including the artifact path),
 *      plus the redacted proof artifact that object points at.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { exitCodeForTask, EXIT_FAILURE, EXIT_NEEDS_ATTENTION, EXIT_PROVEN } from "../src/exit-codes.ts";
import { runCli, type CliContext } from "../src/index.ts";

const exec = promisify(execFile);

type Env = Record<string, string | undefined>;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: readonly string[],
  env: Env,
  options: { isTTY?: boolean } = {},
): Promise<RunResult> {
  const out = { text: "" };
  const err = { text: "" };
  const context: CliContext = {
    stdout: { write: (chunk: string) => ((out.text += chunk), true) },
    stderr: { write: (chunk: string) => ((err.text += chunk), true) },
    env,
    isTTY: options.isTTY ?? false,
  };
  const code = await runCli(argv, context);
  return { code, stdout: out.text, stderr: err.text };
}

const FIXED_SESSION = [
  "function refreshSession() {",
  "  let refreshes = 0;",
  "  refreshes += 1;",
  "  return refreshes;",
  "}",
  "module.exports = { refreshSession };",
  "",
].join("\n");

const SESSION_TEST = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const { refreshSession } = require("../src/auth/session.js");',
  "",
  'test("session refreshes exactly once per expiry", () => {',
  "  assert.equal(refreshSession(), 1);",
  "});",
  "",
].join("\n");

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly home: string;
  readonly env: Env;
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await exec("git", ["-C", root, ...args]);
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "keystone-ci-"));
  const root = join(base, "repo");
  const home = join(base, "home");

  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "src", "auth", "session.js"),
    [
      "function refreshSession() {",
      "  let refreshes = 0;",
      "  refreshes += 1;",
      "  refreshes += 1; // the defect: double refresh",
      "  return refreshes;",
      "}",
      "module.exports = { refreshSession };",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "test", "session.test.js"), SESSION_TEST);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-app", version: "1.0.0", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 })}\n`);

  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "ci@example.com"]);
  await git(root, ["config", "user.name", "CI Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "initial"]);

  return { base, root, home, env: { ...process.env, KEYSTONE_HOME: home, KEYSTONE_LANG: "en" } };
}

function writeAction(path: string, content: string): Record<string, unknown> {
  return {
    intent: "write",
    tool: "fs.write_file",
    parameters: { path, content },
    rationale: `apply the fix in ${path}`,
    expected_effects: [{ kind: "file_modify", target: path, description: "single refresh" }],
    requested_capabilities: ["fs.write"],
    produces_evidence_for: [],
    reversibility: "reversible",
  };
}

function finishAction(): Record<string, unknown> {
  return {
    intent: "finish",
    tool: "fs.read_file",
    parameters: {},
    rationale: "the fix is in place",
    expected_effects: [],
    requested_capabilities: [],
    produces_evidence_for: [],
    reversibility: "reversible",
  };
}

async function writeFixtureFile(base: string, name: string, responses: readonly unknown[]): Promise<string> {
  const file = join(base, name);
  await writeFile(file, `${JSON.stringify(responses, null, 2)}\n`);
  return file;
}

test("exitCodeForTask maps the task-state table without weakening completion", () => {
  // Exit 0 is reserved for proven.
  assert.equal(exitCodeForTask("proven", 0), EXIT_PROVEN);
  // A pause for a human decision is exit 3, never 0 and never a failure.
  assert.equal(exitCodeForTask("needs_attention", 0), EXIT_NEEDS_ATTENTION);
  assert.equal(exitCodeForTask("awaiting_approval", 0), EXIT_NEEDS_ATTENTION);
  // A run that stopped on an unanswered intervention is also exit 3.
  assert.equal(exitCodeForTask("executing", 2), EXIT_NEEDS_ATTENTION);
  // Non-proven terminal ends are failures.
  assert.equal(exitCodeForTask("failed", 0), EXIT_FAILURE);
  assert.equal(exitCodeForTask("exited_gracefully", 0), EXIT_FAILURE);
  assert.equal(exitCodeForTask("stopped", 0), EXIT_FAILURE);
  // The load-bearing invariant: nothing but proven maps to 0.
  for (const status of [
    "draft",
    "defining",
    "ready",
    "executing",
    "verifying",
    "auto_repairing",
    "paused",
    "resuming",
  ] as const) {
    assert.notEqual(exitCodeForTask(status, 0), EXIT_PROVEN, `${status} must not exit 0`);
  }
});

test("keystone ci: a proven offline run exits 0, prints stable JSON, and writes a redacted proof", async () => {
  const fixture = await makeFixture();
  try {
    const fixtureFile = await writeFixtureFile(fixture.base, "scripted.json", [
      { summary: "apply the fix", actions: [writeAction("src/auth/session.js", FIXED_SESSION)] },
      { summary: "done", actions: [finishAction()] },
    ]);
    const artifactPath = join(fixture.base, "proof.json");

    const result = await run(
      [
        "ci",
        "--project", fixture.root,
        "--request", "Fix the duplicate session refresh after expiry in src/auth/session.js.",
        "--ref", "directory:src",
        "--write-path", "src/**",
        "--allow-command", "node",
        "--allow-command", "npm",
        "--allow-command", "pnpm",
        "--accept-contract",
        "--max-steps", "6",
        "--scripted-fixture", fixtureFile,
        "--out", artifactPath,
      ],
      fixture.env,
    );

    assert.equal(result.code, EXIT_PROVEN, `expected exit 0, got ${result.code}\n${result.stderr}`);

    // stdout is exactly one stable JSON object.
    const doc = JSON.parse(result.stdout) as {
      command: string;
      resultVersion: number;
      taskId: string;
      status: string;
      exitCode: number;
      outcome: string;
      artifact: { path: string; bytes: number; redaction: string; proofGraphHash: string } | null;
    };
    assert.equal(doc.command, "keystone.ci");
    assert.equal(doc.resultVersion, 1);
    assert.equal(doc.status, "proven");
    assert.equal(doc.exitCode, EXIT_PROVEN);
    assert.equal(doc.outcome, "proven");
    assert.ok(doc.taskId.length > 0);

    // The artifact the JSON points at exists and is a redacted proof package.
    assert.ok(doc.artifact !== null, "a proven run must export an artifact");
    assert.equal(doc.artifact?.path, artifactPath);
    assert.equal(doc.artifact?.redaction, "metadata_only");
    assert.ok(doc.artifact?.bytes > 0);
    assert.ok(doc.artifact?.proofGraphHash.length > 0);

    const proofText = await readFile(artifactPath, "utf8");
    const proof = JSON.parse(proofText) as {
      redaction: string;
      outcome: string;
      conditions: { satisfied: boolean }[];
    };
    assert.equal(proof.redaction, "metadata_only");
    assert.equal(proof.outcome, "proven");
    assert.ok(proof.conditions.length > 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("keystone ci: an out-of-scope action stops at needs_attention and exits 3 without hanging", async () => {
  const fixture = await makeFixture();
  try {
    const fixtureFile = await writeFixtureFile(fixture.base, "oos.json", [
      { summary: "write outside the scope", actions: [writeAction("config/secrets.yaml", "leaked: true")] },
      { summary: "done", actions: [finishAction()] },
    ]);
    const artifactPath = join(fixture.base, "proof.json");

    const result = await run(
      [
        "ci",
        "--project", fixture.root,
        "--request", "Write the deploy config into config/secrets.yaml.",
        "--write-path", "src/**",
        "--accept-contract",
        "--max-steps", "4",
        "--scripted-fixture", fixtureFile,
        "--out", artifactPath,
      ],
      fixture.env,
    );

    assert.equal(result.code, EXIT_NEEDS_ATTENTION, `expected exit 3, got ${result.code}\n${result.stderr}`);

    const doc = JSON.parse(result.stdout) as {
      status: string;
      exitCode: number;
      artifact: { path: string } | null;
      pendingInterventions: { interventionId: string; question: string }[];
    };
    assert.equal(doc.exitCode, EXIT_NEEDS_ATTENTION);
    assert.notEqual(doc.status, "proven");
    assert.ok(doc.pendingInterventions.length > 0, "the blocked decision must be reported");

    // The out-of-scope write must never have reached the disk.
    await assert.rejects(() => readFile(join(fixture.root, "config", "secrets.yaml"), "utf8"));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("keystone ci: a missing required flag is a usage error (exit 2)", async () => {
  const fixture = await makeFixture();
  try {
    const result = await run(["ci", "--project", fixture.root], fixture.env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--request.*is required/);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("keystone ci: with no model configured it exits 1 and still prints a stable JSON result", async () => {
  const fixture = await makeFixture();
  try {
    const result = await run(
      ["ci", "--project", fixture.root, "--request", "do something"],
      fixture.env,
    );
    assert.equal(result.code, EXIT_FAILURE, result.stderr);
    const doc = JSON.parse(result.stdout) as {
      command: string;
      exitCode: number;
      status: string;
      artifact: unknown;
    };
    assert.equal(doc.command, "keystone.ci");
    assert.equal(doc.exitCode, EXIT_FAILURE);
    assert.equal(doc.status, "failed");
    assert.equal(doc.artifact, null);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
