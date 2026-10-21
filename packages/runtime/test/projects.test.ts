import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { KernelSession, resolveKeystonePaths } from "@keystone/kernel";
import { newId, projectProfileSchema, type ProjectId } from "@keystone/schemas";

const git = promisify(execFile);

async function fixture(t: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), "keystone-projects-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  await mkdir(root);
  await git("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "hello.txt"), "original\n");
  await git("git", ["add", "."], { cwd: root });
  await git("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "initial"], { cwd: root });
  return { temp, root: await realpath(root), paths: resolveKeystonePaths(join(temp, "store")) };
}

test("registers and selects a Git project without creating a task or engineering profile", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  assert.deepEqual(await registry.list(), []);
  const project = await registry.register({ rootPath: f.root, name: "Sample" });
  assert.equal(project.name, "Sample");
  assert.equal(project.rootPath, f.root);
  assert.equal(project.branch, "main");
  assert.equal(project.dirty, false);
  assert.deepEqual(project.tasks, []);
  assert.equal(project.scanStatus, "not_scanned");
  assert.deepEqual(await registry.get(project.projectId), project);
  assert.deepEqual(await new ProjectRegistry(f.paths).list(), [project]);
  await assert.rejects(access(f.paths.tasksDir), { code: "ENOENT" });
  await assert.rejects(access(f.paths.projectFile(project.projectId)), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "original\n");
});

test("missing workspace projects stay selectable and reconnect without changing project identity", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry, ProjectServiceError } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  const project = await registry.register({ rootPath: f.root });
  const relocated = join(f.temp, "relocated");
  await rename(f.root, relocated);
  const missing = await registry.get(project.projectId);
  assert.equal(missing?.status, "missing");
  assert.equal(missing?.dirty, null);
  assert.equal((await registry.list()).length, 1);
  const reconnected = await registry.update(project.projectId, { rootPath: relocated });
  assert.equal(reconnected.projectId, project.projectId);
  assert.notEqual(reconnected.workspaceId, project.workspaceId);
  assert.equal(reconnected.rootPath, await realpath(relocated));
  assert.equal(reconnected.status, "available");
  assert.equal((await registry.register({ rootPath: relocated })).projectId, project.projectId);
  await mkdir(join(relocated, "child"));
  await assert.rejects(registry.update(project.projectId, { rootPath: join(relocated, "child") }),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 400);
  await writeFile(join(relocated, "hello.txt"), "user changed\n");
  assert.equal((await registry.get(project.projectId))?.dirty, true);
});

test("concurrent registry instances cannot lose project metadata or duplicate canonical roots", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry, ProjectServiceError } = await import("../src/projects/registry.ts");
  const a = new ProjectRegistry(f.paths);
  const b = new ProjectRegistry(f.paths);
  const project = await a.register({ rootPath: f.root });
  await Promise.all([a.update(project.projectId, { pinned: true }), b.update(project.projectId, { name: "Concurrent" })]);
  assert.equal((await a.get(project.projectId))?.pinned, true);
  assert.equal((await a.get(project.projectId))?.name, "Concurrent");
  const linked = join(f.temp, "linked");
  await git("git", ["worktree", "add", "-qb", "other", linked], { cwd: f.root });
  const second = await a.register({ rootPath: linked });
  await assert.rejects(b.update(second.projectId, { rootPath: f.root }),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 409);
  await assert.rejects(a.remove("../invalid"),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 400);
});

test("registration rejects non-root, traversal, non-Git and missing directories before storage", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry, ProjectServiceError } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  await mkdir(join(f.root, "child"));
  await mkdir(join(f.temp, "plain"));
  for (const rootPath of [join(f.root, "child"), `${f.root}/../repo`, join(f.temp, "plain"),
    join(f.temp, "missing"), ".", join(f.root, ".git")]) {
    await assert.rejects(registry.register({ rootPath }), (error: unknown) =>
      error instanceof ProjectServiceError && error.status === 400);
  }
  assert.deepEqual(await registry.list(), []);
  await assert.rejects(access(f.paths.projectsDir), { code: "ENOENT" });
});

test("canonical duplicate roots share identity while linked Git worktrees remain separate", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  const alias = join(f.temp, "alias");
  await symlink(f.root, alias, "dir");
  const original = await registry.register({ rootPath: f.root, name: "Original" });
  assert.equal((await registry.register({ rootPath: alias, name: "Ignored" })).projectId, original.projectId);
  const linked = join(f.temp, "linked");
  await git("git", ["worktree", "add", "-qb", "linked-branch", linked], { cwd: f.root });
  const workspace = await registry.register({ rootPath: linked });
  assert.notEqual(workspace.projectId, original.projectId);
  assert.equal(workspace.branch, "linked-branch");
  assert.equal((await registry.list()).length, 2);
});

test("metadata lifecycle preserves user code and independent engineering records", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  const project = await registry.register({ rootPath: f.root });
  await mkdir(f.paths.projectDir(project.projectId), { recursive: true });
  await writeFile(f.paths.projectFile(project.projectId), '{"independent":true}');
  const updated = await registry.update(project.projectId, { name: "Renamed", pinned: true, archived: true });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.pinned, true);
  assert.equal(updated.archived, true);
  await registry.remove(project.projectId);
  assert.equal(await registry.get(project.projectId), undefined);
  assert.deepEqual(await registry.list(), []);
  assert.equal(await readFile(f.paths.projectFile(project.projectId), "utf8"), '{"independent":true}');
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "original\n");
});

test("projects expose validated scan and verified task projections without changing either store", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  const project = await registry.register({ rootPath: f.root });
  const profile = projectProfileSchema.parse({
    projectId: project.workspaceId, rootPath: f.root, name: "Engineering name", vcs: "git",
    languages: ["typescript"], support: { status: "partially_supported", reasons: ["no test command"] },
    commands: [], instructionFiles: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await mkdir(f.paths.projectDir(project.workspaceId), { recursive: true });
  const saved = JSON.stringify(profile);
  await writeFile(f.paths.projectFile(project.workspaceId), saved);
  const task = await KernelSession.create({ paths: f.paths, projectId: project.projectId, request: "do not execute" });
  await KernelSession.create({ paths: f.paths, projectId: newId("proj") as ProjectId, request: "unrelated" });
  const originalLedger = await readFile(f.paths.ledgerFile(task.taskId), "utf8");
  const scanned = await registry.get(project.projectId);
  assert.equal(scanned?.scanStatus, "scanned");
  assert.deepEqual(scanned?.support, profile.support);
  assert.deepEqual(scanned?.tasks, [task.taskId]);
  assert.notEqual(scanned?.name, profile.name);
  assert.equal(await readFile(f.paths.projectFile(project.workspaceId), "utf8"), saved);
  assert.equal(await readFile(f.paths.ledgerFile(task.taskId), "utf8"), originalLedger);
  await rename(f.root, join(f.temp, "relocated"));
  const missing = await registry.get(project.projectId);
  assert.equal(missing?.status, "missing");
  assert.deepEqual(missing?.tasks, [task.taskId]);
  assert.equal(missing?.scanStatus, "scanned");
});

test("invalid registry inputs and unreadable engineering projections fail explicitly", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry, ProjectServiceError } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  await assert.rejects(registry.register({ rootPath: f.root, name: "  " }),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 400);
  const project = await registry.register({ rootPath: f.root });
  await assert.rejects(registry.update(project.projectId, { name: "" }),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 400);
  await mkdir(f.paths.projectDir(project.workspaceId), { recursive: true });
  await writeFile(f.paths.projectFile(project.workspaceId), '{"unsupported":"invalid"}');
  const unreadable = await registry.get(project.projectId);
  assert.equal(unreadable?.status, "available");
  assert.equal(unreadable?.scanStatus, "unavailable");
  assert.equal(unreadable?.support.status, "unknown");
  assert.ok(unreadable?.support.reasons.length);
});

test("reconnected project identities cannot be duplicated by registering a recreated former root", async (t) => {
  const f = await fixture(t);
  const { ProjectRegistry, ProjectServiceError } = await import("../src/projects/registry.ts");
  const registry = new ProjectRegistry(f.paths);
  const original = await registry.register({ rootPath: f.root });
  const moved = join(f.temp, "moved");
  await rename(f.root, moved);
  await registry.update(original.projectId, { rootPath: moved });
  await mkdir(f.root);
  await git("git", ["init", "-q", "-b", "new-root"], { cwd: f.root });
  await assert.rejects(registry.register({ rootPath: f.root }),
    (error: unknown) => error instanceof ProjectServiceError && error.status === 409);
  const all = await registry.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.projectId, original.projectId);
  assert.equal(all[0]?.rootPath, await realpath(moved));
});
