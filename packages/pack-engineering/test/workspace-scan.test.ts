/**
 * Focused tests for Git work-tree scanning and project profiling (ADR-0006).
 *
 * Extracted verbatim from `packages/kernel/test/project-evidence.test.ts` when the
 * scanners moved into the pack. They pin identical scan/profile output.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newId, type ProjectId } from "@keystone/schemas";

import {
  detectProjectProfile,
  NotAGitRepositoryError,
  scanWorkspace,
} from "../src/index.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Keystone Test"]);
}

test("scanWorkspace fingerprints a real git work tree and detects changes", async () => {
  const dir = await tempDir("keystone-scan-");
  try {
    await initRepo(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "init"]);

    const clean = await scanWorkspace(dir);
    assert.equal(clean.dirty, false);
    assert.equal(clean.untrackedCount, 0);
    assert.equal(clean.entryCount, 2);
    assert.equal(clean.entriesTruncated, false);
    assert.equal(clean.fingerprint.length, 64);
    assert.notEqual(clean.headCommit, undefined);
    assert.deepEqual(clean.excluded, []);

    await writeFile(join(dir, "src", "index.ts"), "export const x = 2;\n");
    const modified = await scanWorkspace(dir);
    assert.equal(modified.dirty, true);
    assert.notEqual(modified.fingerprint, clean.fingerprint);

    await writeFile(join(dir, "untracked.txt"), "hello\n");
    const withUntracked = await scanWorkspace(dir);
    assert.equal(withUntracked.untrackedCount, 1);
    assert.equal(withUntracked.entryCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanWorkspace refuses a directory that is not a Git repository", async () => {
  const dir = await tempDir("keystone-nogit-");
  try {
    await assert.rejects(() => scanWorkspace(dir), NotAGitRepositoryError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectProjectProfile recognises a supported pnpm TypeScript project", async () => {
  const dir = await tempDir("keystone-profile-");
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const profile = await detectProjectProfile(dir, newId("proj") as ProjectId);
    assert.equal(profile.support.status, "supported");
    assert.equal(profile.packageManager, "pnpm");
    assert.ok(profile.languages.includes("typescript"));

    const testCommand = profile.commands.find((command) => command.kind === "test");
    assert.equal(testCommand?.status, "identified");
    assert.equal(testCommand?.command, "pnpm test");
    assert.equal(testCommand?.source, "package.json#scripts.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectProjectProfile marks an absent command as unrecognized without guessing", async () => {
  const dir = await tempDir("keystone-profile-");
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node ." } }));
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const profile = await detectProjectProfile(dir, newId("proj") as ProjectId);
    const testCommand = profile.commands.find((command) => command.kind === "test");
    assert.equal(testCommand?.status, "unrecognized");
    assert.equal(testCommand?.command, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project command uses the detected npm/yarn manager and cannot guess a missing manager", async () => {
  for (const [lock, expected] of [
    ["package-lock.json", "npm run test"],
    ["yarn.lock", "yarn run test"],
    ["", undefined],
  ] as const) {
    const dir = await tempDir("keystone-profile-manager-");
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      if (lock) await writeFile(join(dir, lock), "{}");
      const profile = await detectProjectProfile(dir, newId("proj") as ProjectId);
      assert.equal(profile.commands.find((entry) => entry.kind === "test")?.command, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
