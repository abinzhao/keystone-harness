#!/usr/bin/env node
/**
 * Offline CI proof smoke — exercises the real `keystone ci` binary end-to-end.
 *
 * This is deliberately an external consumer of the CLI, not an in-process test:
 * it spawns `bin.ts` exactly as a CI job would, on a throwaway git repo with the
 * offline scripted model (no network, no key), and asserts the three things a CI
 * runner depends on:
 *
 *   1. the process exit code is 0 for a proven run,
 *   2. stdout is one stable JSON object pointing at a proof artifact,
 *   3. that artifact exists and is redacted (`metadata_only`).
 *
 * Run from the repo root:  node scripts/ci/smoke-offline-proof.mjs
 * Exits non-zero (and prints why) on any mismatch.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = join(repoRoot, "packages", "cli", "src", "bin.ts");

function check(cond, message) {
  if (!cond) {
    console.error(`smoke FAIL: ${message}`);
    process.exit(1);
  }
}

const base = mkdtempSync(join(tmpdir(), "keystone-smoke-"));
try {
  const repo = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });

  writeFileSync(
    join(repo, "src", "session.js"),
    [
      "function refreshSession() {",
      "  let refreshes = 0;",
      "  refreshes += 1;",
      "  refreshes += 1; // defect: double refresh",
      "  return refreshes;",
      "}",
      "module.exports = { refreshSession };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "test", "session.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const { refreshSession } = require("../src/session.js");',
      "",
      'test("session refreshes exactly once per expiry", () => {',
      "  assert.equal(refreshSession(), 1);",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "smoke-app",
      version: "1.0.0",
      scripts: { test: "node --test" },
    }) + "\n",
  );

  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "smoke@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Smoke"]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);

  const fixed = [
    "function refreshSession() {",
    "  let refreshes = 0;",
    "  refreshes += 1;",
    "  return refreshes;",
    "}",
    "module.exports = { refreshSession };",
    "",
  ].join("\n");

  const fixture = join(base, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify([
      {
        summary: "apply the fix",
        actions: [
          {
            intent: "write",
            tool: "fs.write_file",
            parameters: { path: "src/session.js", content: fixed },
            rationale: "single refresh",
            expected_effects: [
              { kind: "file_modify", target: "src/session.js", description: "single refresh" },
            ],
            requested_capabilities: ["fs.write"],
            produces_evidence_for: [],
            reversibility: "reversible",
          },
        ],
      },
      {
        summary: "done",
        actions: [
          {
            intent: "finish",
            tool: "fs.read_file",
            parameters: {},
            rationale: "the fix is in place",
            expected_effects: [],
            requested_capabilities: [],
            produces_evidence_for: [],
            reversibility: "reversible",
          },
        ],
      },
    ]),
  );

  const artifact = join(base, "proof.json");
  const { error, status, stdout } = spawnSync(
    process.execPath,
    [
      bin, "ci",
      "--project", repo,
      "--request", "Fix the duplicate session refresh in src/session.js.",
      "--ref", "directory:src",
      "--write-path", "src/**",
      "--allow-command", "node",
      "--allow-command", "npm",
      "--allow-command", "pnpm",
      "--accept-contract",
      "--max-steps", "6",
      "--scripted-fixture", fixture,
      "--out", artifact,
    ],
    {
      env: { ...process.env, KEYSTONE_HOME: home, KEYSTONE_LANG: "en" },
      encoding: "utf8",
    },
  );

  check(!error, `failed to spawn: ${error?.message ?? error}`);
  check(status === 0, `expected exit 0 for a proven run, got ${status}\n${stdout}`);

  const doc = JSON.parse(stdout);
  check(doc.command === "keystone.ci", `unexpected command: ${doc.command}`);
  check(doc.status === "proven", `expected status proven, got ${doc.status}`);
  check(doc.exitCode === 0, `expected exitCode 0, got ${doc.exitCode}`);
  check(doc.artifact && doc.artifact.path === artifact, "artifact path not reported");
  check(doc.artifact.redaction === "metadata_only", `redaction=${doc.artifact.redaction}`);

  const proof = JSON.parse(readFileSync(artifact, "utf8"));
  check(proof.redaction === "metadata_only", "artifact file redaction mismatch");
  check(proof.outcome === "proven", `artifact outcome=${proof.outcome}`);

  console.error("smoke OK: keystone ci proven exit 0; redacted proof exported");
} finally {
  rmSync(base, { recursive: true, force: true });
}
