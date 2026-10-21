/**
 * Shared acceptance fixtures.
 *
 * A real Git repository with a real failing test and a real defect. Nothing here
 * is mocked: the point of these tests is that the harness is exercised against
 * the same things a user would have.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveKeystonePaths } from "@keystone/kernel";
import { autonomyEnvelopeSchema, newId, type AutonomyEnvelope } from "@keystone/schemas";

export const run = promisify(execFile);

export const BUGGY_SESSION = [
  "// Simulates the duplicate-refresh defect: two timers fire after expiry.",
  "function refreshSession() {",
  "  let refreshes = 0;",
  "  refreshes += 1;",
  "  refreshes += 1;",
  "  return refreshes;",
  "}",
  "module.exports = { refreshSession };",
  "",
].join("\n");

export const FIXED_SESSION = [
  "// Fixed: a single refresh is scheduled per expiry.",
  "function refreshSession() {",
  "  let refreshes = 0;",
  "  refreshes += 1;",
  "  return refreshes;",
  "}",
  "module.exports = { refreshSession };",
  "",
].join("\n");

export const WRONG_FIX_SESSION = [
  "// Attempted fix that still refreshes twice: the timer is re-registered on entry.",
  "function refreshSession() {",
  "  let refreshes = 0;",
  "  refreshes += 1;",
  "  if (true) { refreshes += 1; }",
  "  return refreshes;",
  "}",
  "module.exports = { refreshSession };",
  "",
].join("\n");

export const SESSION_TEST = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const { refreshSession } = require("../src/auth/session.js");',
  "",
  'test("session refreshes exactly once per expiry", () => {',
  "  assert.equal(refreshSession(), 1);",
  "});",
  "",
].join("\n");

export interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly paths: ReturnType<typeof resolveKeystonePaths>;
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "keystone-acceptance-"));
  const home = await mkdtemp(join(tmpdir(), "keystone-acceptance-store-"));

  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src", "auth", "session.js"), BUGGY_SESSION);
  await writeFile(join(root, "test", "session.test.js"), SESSION_TEST);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", scripts: { test: "node --test" } }, null, 2),
  );
  // A lockfile makes the package manager unambiguous without needing a network.
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "acceptance@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-q", "-m", "initial"], { cwd: root });

  return { root, home, paths: resolveKeystonePaths(home) };
}

export async function removeFixture(fixture: Fixture): Promise<void> {
  // A run that is finishing can still be flushing its last checkpoint or a
  // verification child's output while teardown starts. A recursive remove that
  // races with a create fails with ENOTEMPTY on POSIX, so the removal retries
  // instead of failing a test that already passed its assertions.
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function autonomyFor(writePaths: readonly string[]): AutonomyEnvelope {
  return autonomyEnvelopeSchema.parse({
    projectId: newId("proj"),
    readPaths: ["**"],
    writePaths: [...writePaths],
    allowedCommands: ["node", "npm", "pnpm", "npx"],
    allowedHosts: [],
    allowedCredentials: [],
    externalSystems: "none",
    maxReversibility: "reversible",
    untrustedContentEgress: "deny_all",
    budget: { maxTokens: 200_000, maxWallClockMs: 600_000, maxRetries: 3 },
    updatedAt: new Date().toISOString(),
    updatedBy: "user",
    widenedBy: [],
  }) as AutonomyEnvelope;
}

export function envelopeFor(actions: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ summary: "scripted plan", actions });
}

export function writeAction(path: string, content: string): Record<string, unknown> {
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

export const FINISH_ACTION = {
  intent: "finish",
  tool: "fs.read_file",
  parameters: {},
  rationale: "the change is in place",
  expected_effects: [],
  requested_capabilities: [],
  produces_evidence_for: [],
  reversibility: "reversible",
} as const;

/**
 * Run the fixture's own test suite, to confirm a fix is genuinely correct.
 *
 * `NODE_TEST_CONTEXT` is stripped on purpose: a `node --test` child of a running
 * test process inherits it and then skips directory discovery, exiting 0 without
 * running anything. That is a false "pass" caused purely by the environment —
 * exactly the failure mode the harness's own sanitised environment avoids.
 */
export async function fixtureTestsPass(root: string): Promise<boolean> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "NODE_TEST_CONTEXT") continue;
    if (value !== undefined) env[key] = value;
  }
  try {
    await run("npm", ["run", "test"], { cwd: root, env });
    return true;
  } catch {
    return false;
  }
}
