import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { getArtifactText, resolveKeystonePaths, resourceKindFor, type KeystonePaths } from "@keystone/kernel";
import {
  capabilityLeaseSchema,
  getSchema,
  newId,
  type Capability,
  type CapabilityLease,
} from "@keystone/schemas";

import { deleteFileTool, listDirTool, readFileTool, searchTextTool, writeFileTool } from "../src/fs.ts";
import { gitDiffTool, gitShowHeadTool, gitStatusTool } from "../src/git.ts";
import { sanitizeEnv } from "../src/guard.ts";
import { TOOL_IDS, builtinTools, describeTool, getTool, toolDescriptors } from "../src/index.ts";
import { runCommandTool } from "../src/shell.ts";
import { PathEscapeError, ToolRefusedError, type ToolContext } from "../src/types.ts";

const exec = promisify(execFile);

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly paths: KeystonePaths;
}

/**
 * A real git worktree and an isolated Keystone store, so the tests exercise the
 * same process and path semantics the runtime will, without touching the user's
 * `~/.keystone`.
 */
async function withRepo<T>(fn: (fixture: Fixture) => Promise<T>): Promise<T> {
  const repo = await mkdtemp(join(tmpdir(), "keystone-tools-repo-"));
  const home = await mkdtemp(join(tmpdir(), "keystone-tools-home-"));
  try {
    await exec("git", ["init", "-q"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "Keystone Test"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "README.md"), "# repo\n");
    await writeFile(join(repo, "src", "app.txt"), "hello needle world\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    return await fn({ repo, home, paths: resolveKeystonePaths(home) });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

/** A lease built through the real schema, not a hand-rolled object. */
function makeLease(
  capability: Capability,
  values: readonly string[],
  overrides: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
): CapabilityLease {
  return capabilityLeaseSchema.parse({
    leaseId: newId("lease"),
    taskId: newId("task"),
    branchId: newId("branch"),
    subject: { kind: "builder_loop", id: "builder" },
    capability,
    resource: { kind: resourceKindFor(capability), values: [...values] },
    constraints: {
      denySymlinkEscape: true,
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
      ...(overrides.maxOutputBytes === undefined ? {} : { maxOutputBytes: overrides.maxOutputBytes }),
    },
    budget: { maxCalls: 16 },
    scopeDigest: "a".repeat(64),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedBy: "kernel",
    status: "active",
    consumedCalls: 0,
  }) as CapabilityLease;
}

function makeContext(fixture: Fixture, lease: CapabilityLease): ToolContext {
  return {
    rootPath: fixture.repo,
    taskId: lease.taskId,
    branchId: lease.branchId,
    paths: fixture.paths,
    lease,
    workingDirectory: fixture.repo,
  };
}

test("write_file writes inside scope and reports the changed path", async () => {
  await withRepo(async (fixture) => {
    const lease = makeLease("fs.write", ["src/app.txt"]);
    const result = await writeFileTool.run(
      { path: "src/app.txt", content: "updated\n" },
      makeContext(fixture, lease),
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.changedPaths, ["src/app.txt"]);
    assert.equal(result.truncated, false);
    const onDisk = await readFile(join(fixture.repo, "src", "app.txt"), "utf8");
    assert.equal(onDisk, "updated\n");
  });
});

test("write_file refuses a path outside the lease and creates nothing", async () => {
  await withRepo(async (fixture) => {
    const lease = makeLease("fs.write", ["src/app.txt"]);
    const target = join(fixture.repo, "src", "other.txt");
    await assert.rejects(
      writeFileTool.run({ path: "src/other.txt", content: "nope" }, makeContext(fixture, lease)),
      ToolRefusedError,
    );
    // The refusal happened before the write, so nothing was created.
    await assert.rejects(access(target));
  });
});

test('a "../" path escapes the root and is rejected before any write', async () => {
  await withRepo(async (fixture) => {
    // The lease is deliberately permissive so the failure is containment, not scope.
    const lease = makeLease("fs.write", ["**"]);
    await assert.rejects(
      writeFileTool.run({ path: "../outside.txt", content: "nope" }, makeContext(fixture, lease)),
      PathEscapeError,
    );
    await assert.rejects(access(resolve(fixture.repo, "..", "outside.txt")));
  });
});

test("run_command refuses an executable name containing a path separator", async () => {
  await withRepo(async (fixture) => {
    const lease = makeLease("cmd.exec", ["evil.sh"]);
    await assert.rejects(
      runCommandTool.run({ command: "./evil.sh" }, makeContext(fixture, lease)),
      ToolRefusedError,
    );
  });
});

test("run_command executes an allowed bare command and captures stdout", async () => {
  await withRepo(async (fixture) => {
    const lease = makeLease("cmd.exec", ["node"]);
    const result = await runCommandTool.run(
      { command: "node", args: ["-e", "console.log(1)"] },
      makeContext(fixture, lease),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.equal((result.stdout ?? "").trim(), "1");
  });
});

test("sanitizeEnv drops credential-shaped variables and keeps plumbing", () => {
  const filtered = sanitizeEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    LANG: "en_US.UTF-8",
    MY_TOKEN: "secret-value",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  });
  assert.equal(filtered["PATH"], "/usr/bin");
  assert.equal(filtered["HOME"], "/home/user");
  assert.equal(filtered["LANG"], "en_US.UTF-8");
  assert.equal(filtered["MY_TOKEN"], undefined);
  assert.equal(filtered["AWS_SECRET_ACCESS_KEY"], undefined);

  const extra = sanitizeEnv({}, { FOO: "bar", MY_KEY: "secret" });
  assert.equal(extra["FOO"], "bar");
  assert.equal(extra["MY_KEY"], undefined);
});

test("output past maxBytes is truncated and stored as an artifact", async () => {
  await withRepo(async (fixture) => {
    const lease = makeLease("cmd.exec", ["node"], { maxOutputBytes: 1_024 });
    const script = "process.stdout.write('x'.repeat(5000))";
    const result = await runCommandTool.run(
      { command: "node", args: ["-e", script] },
      makeContext(fixture, lease),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.truncated, true);
    assert.ok((result.stdout ?? "").length <= 1_024);
    assert.ok(result.artifactId, "a truncated result must reference the full output");

    const stored = await getArtifactText(fixture.paths, result.artifactId as string);
    assert.ok(stored !== undefined);
    const parsed = JSON.parse(stored) as { stdout: string; stderr: string };
    assert.equal(parsed.stdout.length, 5_000);
  });
});

test("search_text finds matches and skips node_modules", async () => {
  await withRepo(async (fixture) => {
    await mkdir(join(fixture.repo, "node_modules", "dep"), { recursive: true });
    await writeFile(join(fixture.repo, "node_modules", "dep", "x.txt"), "needle in deps\n");
    await writeFile(join(fixture.repo, "src", "needle.txt"), "a needle here\n");

    const lease = makeLease("fs.read", ["**"]);
    const result = await searchTextTool.run({ pattern: "needle" }, makeContext(fixture, lease));
    assert.equal(result.status, "succeeded");
    assert.match(result.stdout ?? "", /src\/needle\.txt:1:a needle here/);
    assert.doesNotMatch(result.stdout ?? "", /node_modules/);
  });
});

test("git status reflects an uncommitted change", async () => {
  await withRepo(async (fixture) => {
    await writeFile(join(fixture.repo, "README.md"), "# repo changed\n");
    const lease = makeLease("git.read", ["."]);
    const result = await gitStatusTool.run({}, makeContext(fixture, lease));
    assert.equal(result.status, "succeeded");
    assert.match(result.stdout ?? "", /README\.md/);
  });
});

test("every descriptor's input and output schema resolves in the registry", () => {
  const descriptors = toolDescriptors();
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.id),
    [...TOOL_IDS],
  );
  for (const descriptor of descriptors) {
    assert.ok(getSchema(descriptor.inputSchemaId), `missing input schema ${descriptor.inputSchemaId}`);
    assert.ok(getSchema(descriptor.outputSchemaId), `missing output schema ${descriptor.outputSchemaId}`);
  }
  assert.equal(builtinTools().length, TOOL_IDS.length);
  assert.ok(getTool("fs.write_file"));
  assert.match(describeTool("cmd.run"), /cmd\.run/);
  assert.match(describeTool("does.not.exist"), /unknown tool/);
});

// Smoke coverage for the remaining built-ins so none ships untested.
test("read_file, list_dir, delete_file, git diff and git show_head work end to end", async () => {
  await withRepo(async (fixture) => {
    const readResult = await readFileTool.run(
      { path: "src/app.txt" },
      makeContext(fixture, makeLease("fs.read", ["src/app.txt"])),
    );
    assert.equal(readResult.status, "succeeded");
    assert.equal(readResult.stdout, "hello needle world\n");

    const listResult = await listDirTool.run(
      { path: "src" },
      makeContext(fixture, makeLease("fs.read", ["src"])),
    );
    assert.equal(listResult.status, "succeeded");
    assert.match(listResult.stdout ?? "", /src\/app\.txt/);

    await writeFile(join(fixture.repo, "src", "tmp.txt"), "temporary\n");
    const deleteResult = await deleteFileTool.run(
      { path: "src/tmp.txt" },
      makeContext(fixture, makeLease("fs.delete", ["src/tmp.txt"])),
    );
    assert.equal(deleteResult.status, "succeeded");
    assert.deepEqual(deleteResult.changedPaths, ["src/tmp.txt"]);
    await assert.rejects(access(join(fixture.repo, "src", "tmp.txt")));

    await writeFile(join(fixture.repo, "src", "app.txt"), "changed body\n");
    const diffResult = await gitDiffTool.run(
      { path: "src/app.txt" },
      makeContext(fixture, makeLease("git.read", ["."])),
    );
    assert.equal(diffResult.status, "succeeded");
    assert.match(diffResult.stdout ?? "", /changed body/);

    const showResult = await gitShowHeadTool.run(
      { path: "src/app.txt" },
      makeContext(fixture, makeLease("git.read", ["."])),
    );
    assert.equal(showResult.status, "succeeded");
    assert.match(showResult.stdout ?? "", /hello needle world/);
  });
});
