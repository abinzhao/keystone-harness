/**
 * CLI acceptance tests.
 *
 * These drive `runCli` directly (fast, no subprocess) against a temporary
 * Keystone home and a real Git fixture repository, plus one test that spawns
 * `bin.ts` to prove the executable entry point works.
 *
 * The end-to-end test runs a task with the built-in scripted model
 * (`--scripted-fixture`), then checks the proof and replay *through the CLI* —
 * which is exactly PRD 14 item 12.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { listSchemas } from "@keystone/schemas";
import { FileCredentialStore } from "@keystone/models";
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
  options: { isTTY?: boolean; stdin?: AsyncIterable<string> } = {},
): Promise<RunResult> {
  const out = { text: "" };
  const err = { text: "" };
  const context: CliContext = {
    stdout: { write: (chunk: string) => ((out.text += chunk), true) },
    stderr: { write: (chunk: string) => ((err.text += chunk), true) },
    env,
    isTTY: options.isTTY ?? false,
    credentials: new FileCredentialStore({ credentialsDir: join(env["KEYSTONE_HOME"]!, "credentials") }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  };
  const code = await runCli(argv, context);
  return { code, stdout: out.text, stderr: err.text };
}

const BUGGY_SESSION = [
  "function refreshSession() {",
  "  let refreshes = 0;",
  "  refreshes += 1;",
  "  refreshes += 1;", // the defect: double refresh
  "  return refreshes;",
  "}",
  "module.exports = { refreshSession };",
  "",
].join("\n");

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
  const base = await mkdtemp(join(tmpdir(), "keystone-cli-"));
  const root = join(base, "repo");
  const home = join(base, "home"); // outside the repo, so git status stays clean

  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src", "auth", "session.js"), BUGGY_SESSION);
  // A TypeScript source puts the project inside the supported matrix.
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "test", "session.test.js"), SESSION_TEST);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-app", version: "1.0.0", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 })}\n`);

  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "cli@example.com"]);
  await git(root, ["config", "user.name", "CLI Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "initial"]);

  // These tests assert on English wording, so they pin the language instead of
  // depending on the shipped default (which is Chinese).
  return {
    base,
    root,
    home,
    env: { ...process.env, KEYSTONE_HOME: home, KEYSTONE_LANG: "en" },
  };
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

test("--help lists the main commands and exits 0", async () => {
  const fixture = await makeFixture();
  try {
    const result = await run(["--help"], fixture.env);
    assert.equal(result.code, 0);
    for (const name of ["project", "task", "proof", "replay", "protocol", "model", "doctor"]) {
      assert.match(result.stdout, new RegExp(name));
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("an unknown command or flag is a usage error (exit 2)", async () => {
  const fixture = await makeFixture();
  try {
    const unknownCommand = await run(["frobnicate"], fixture.env);
    assert.equal(unknownCommand.code, 2);
    assert.match(unknownCommand.stderr, /unknown command/i);

    const unknownFlag = await run(["project", "inspect", fixture.root, "--nope"], fixture.env);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.stderr, /unknown flag/i);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("project inspect reports detection and marks unidentified commands as unrecognized", async () => {
  const fixture = await makeFixture();
  try {
    const result = await run(["project", "inspect", fixture.root, "--json"], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout) as {
      profile: {
        languages: string[];
        packageManager?: string;
        support: { status: string };
        commands: { kind: string; status: string; command?: string }[];
      };
    };
    assert.ok(data.profile.languages.includes("typescript"), "typescript should be detected");
    assert.equal(data.profile.packageManager, "npm");
    assert.equal(data.profile.support.status, "supported");

    const unrecognized = data.profile.commands.filter((command) => command.status === "unrecognized");
    assert.ok(unrecognized.length > 0, "at least one command should be unrecognized");
    for (const command of unrecognized) {
      assert.equal(command.command, undefined, "an unrecognized command must not carry a guessed command");
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("protocol export writes one file per schema plus an index", async () => {
  const fixture = await makeFixture();
  try {
    const outDir = join(fixture.base, "protocol");
    const result = await run(["protocol", "export", "--out", outDir, "--json"], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout) as { count: number };

    const expected = listSchemas().length;
    assert.equal(data.count, expected);

    const files = await readdir(outDir);
    assert.ok(files.includes("index.json"));
    const schemaFiles = files.filter((file) => file.endsWith(".json") && file !== "index.json");
    assert.equal(schemaFiles.length, expected);

    const sample = schemaFiles.find((file) => file.includes("@"));
    assert.ok(sample !== undefined, "at least one <id>@<version>.json file should exist");
    const parsed = JSON.parse(await readFile(join(outDir, sample), "utf8")) as { $id?: unknown };
    assert.equal(typeof parsed.$id, "string");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("credentials are stored but never echoed to stdout or written into the config", async () => {
  const fixture = await makeFixture();
  const secret = "sk-super-secret-value-1234567890";
  try {
    const added = await run(
      [
        "model", "add",
        "--id", "my-model",
        "--kind", "cloud",
        "--provider", "openai",
        "--model", "gpt-4o-mini",
        "--base-url", "https://api.example.com/v1",
        "--endpoint-host", "api.example.com",
        "--credential-handle", "my-model",
      ],
      fixture.env,
    );
    assert.equal(added.code, 0, added.stderr);

    const set = await run(["model", "credential", "set", "my-model", "--json"], fixture.env, {
      stdin: Readable.from([secret]),
    });
    assert.equal(set.code, 0, set.stderr);
    assert.ok(!set.stdout.includes(secret), "stdout must never contain the secret");
    const setData = JSON.parse(set.stdout) as { fileMode: string };
    assert.equal(setData.fileMode, "0600");

    const list = await run(["model", "credential", "list"], fixture.env);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /my-model/);
    assert.ok(!list.stdout.includes(secret), "the handle listing must never contain the secret");

    const configText = await readFile(join(fixture.home, "config.json"), "utf8");
    assert.ok(!configText.includes(secret), "the config file must reference the handle, not the secret");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("doctor exits 0 in a fresh home and reports Node and schema counts", async () => {
  const fixture = await makeFixture();
  try {
    const human = await run(["doctor"], fixture.env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /node/i);
    assert.match(human.stdout, /protocol schemas/i);

    const json = await run(["doctor", "--json"], fixture.env);
    assert.equal(json.code, 0, json.stderr);
    const data = JSON.parse(json.stdout) as {
      node: { version: string };
      registry: { schemas: number };
    };
    assert.equal(typeof data.node.version, "string");
    assert.ok(data.registry.schemas > 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("end to end: a scripted run is proven, the proof shows no E0 evidence, and replay is consistent", async () => {
  const fixture = await makeFixture();
  try {
    const fixtureFile = await writeFixtureFile(fixture.base, "scripted.json", [
      { summary: "apply the fix", actions: [writeAction("src/auth/session.js", FIXED_SESSION)] },
      { summary: "done", actions: [finishAction()] },
    ]);

    const runResult = await run(
      [
        "task", "run",
        "--project", fixture.root,
        "--request", "Fix the duplicate session refresh after expiry in src/auth/session.js and keep existing behaviour unchanged.",
        "--ref", "directory:src",
        "--write-path", "src/**",
        "--allow-command", "node",
        "--allow-command", "npm",
        "--allow-command", "pnpm",
        "--accept-contract",
        "--max-steps", "6",
        "--scripted-fixture", fixtureFile,
        "--json",
      ],
      fixture.env,
    );
    assert.equal(runResult.code, 0, `expected a proven task, got exit ${runResult.code}\n${runResult.stderr}`);
    const data = JSON.parse(runResult.stdout) as { taskId: string; status: string; outcome: string };
    assert.equal(data.status, "proven");
    assert.equal(data.outcome, "proven");
    const taskId = data.taskId;

    const proofResult = await run(["proof", "show", taskId, "--json"], fixture.env);
    assert.equal(proofResult.code, 0, proofResult.stderr);
    const proof = JSON.parse(proofResult.stdout) as {
      outcome: string;
      evidenceIndex: { level: string }[];
    };
    assert.equal(proof.outcome, "proven");
    assert.ok(proof.evidenceIndex.length > 0, "a proven task must have evidence");
    assert.ok(
      proof.evidenceIndex.every((entry) => entry.level !== "E0"),
      "model claims (E0) must never appear as supporting evidence",
    );

    const replayResult = await run(["replay", taskId, "--json"], fixture.env);
    assert.equal(replayResult.code, 0, replayResult.stderr);
    const replay = JSON.parse(replayResult.stdout) as { consistent: boolean };
    assert.equal(replay.consistent, true);
    await writeFile(join(fixture.root, "src/auth/session.js"), `${FIXED_SESSION}// later user change\n`);
    const changed = await run(["proof", "show", taskId, "--json"], fixture.env);
    assert.equal((JSON.parse(changed.stdout) as { outcome: string }).outcome, "not_proven");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("non-interactive: an out-of-scope action does not hang and exits 3 with a pending item", async () => {
  const fixture = await makeFixture();
  try {
    const fixtureFile = await writeFixtureFile(fixture.base, "out-of-scope.json", [
      { summary: "write outside the scope", actions: [writeAction("config/secrets.yaml", "leaked: true")] },
      { summary: "done", actions: [finishAction()] },
    ]);

    const result = await run(
      [
        "task", "run",
        "--project", fixture.root,
        "--request", "Write the deploy config into config/secrets.yaml.",
        "--ref", "directory:src",
        "--write-path", "src/**",
        "--accept-contract",
        "--max-steps", "4",
        "--scripted-fixture", fixtureFile,
        "--non-interactive",
        "--json",
      ],
      fixture.env,
    );

    assert.equal(result.code, 3, `expected exit 3, got ${result.code}\n${result.stderr}`);
    assert.match(result.stderr, /Pending decision/i);

    const data = JSON.parse(result.stdout) as {
      status: string;
      pendingInterventions: { question: string }[];
    };
    assert.notEqual(data.status, "proven");
    assert.ok(data.pendingInterventions.length > 0, "the pending decision must be reported");

    // The out-of-scope write must never have reached the disk.
    await assert.rejects(() => readFile(join(fixture.root, "config", "secrets.yaml"), "utf8"));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the executable entry point runs through node", async () => {
  const base = await mkdtemp(join(tmpdir(), "keystone-cli-bin-"));
  try {
    const binPath = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const { stdout } = await exec(process.execPath, [binPath, "--help"], {
      env: { ...process.env, KEYSTONE_HOME: join(base, "home"), KEYSTONE_LANG: "en" },
    });
    assert.match(stdout, /task/);
    assert.match(stdout, /keystone/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the default language is Chinese and --lang switches to English", async () => {
  const base = await mkdtemp(join(tmpdir(), "keystone-cli-lang-"));
  try {
    const env: Env = { ...process.env, KEYSTONE_HOME: join(base, "home") };

    const chinese = await run(["--help"], env);
    assert.equal(chinese.code, 0);
    assert.match(chinese.stdout, /命令：/);

    // Both `--lang en` and `--lang=en` are accepted.
    const spaced = await run(["--help", "--lang", "en"], env);
    assert.match(spaced.stdout, /Commands:/);

    const inline = await run(["--help", "--lang=en"], env);
    assert.match(inline.stdout, /Commands:/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("KEYSTONE_LANG drives the language, and --lang overrides it", async () => {
  const base = await mkdtemp(join(tmpdir(), "keystone-cli-lang-env-"));
  try {
    const home = join(base, "home");

    const fromEnv = await run(["--help"], { ...process.env, KEYSTONE_HOME: home, KEYSTONE_LANG: "en" });
    assert.match(fromEnv.stdout, /Commands:/);

    const forcedBack = await run(["--help", "--lang", "zh-CN"], {
      ...process.env,
      KEYSTONE_HOME: home,
      KEYSTONE_LANG: "en",
    });
    assert.match(forcedBack.stdout, /命令：/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
