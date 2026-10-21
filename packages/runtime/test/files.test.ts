import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { resolveKeystonePaths } from "@keystone/kernel";
import { sha256Hex } from "@keystone/schemas";

const git = promisify(execFile);

async function fixture(t: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), "keystone-files-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  await mkdir(root);
  await git("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "hello.txt"), "first line\nneedle second\n");
  await git("git", ["add", "."], { cwd: root });
  await git("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "initial"], { cwd: root });
  return { temp, root: await realpath(root), paths: resolveKeystonePaths(join(temp, "store")) };
}

test("reads complete text with a content hash and no mutation authorization", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    ...f, rootPath: f.root,
    boundary: { async execute() { throw new Error("reads must not request mutation authority"); } },
  });
  assert.deepEqual(await service.read({ path: "hello.txt" }), {
    path: "hello.txt", content: "first line\nneedle second\n",
    hash: sha256Hex("first line\nneedle second\n"), size: 25, binary: false, truncated: false,
  });
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "first line\nneedle second\n");
});

test("read confinement rejects lexical escapes and symlinks to outside or Git internals", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths, boundary: { async execute() { throw new Error("unexpected"); } },
  });
  await writeFile(join(f.temp, "private.txt"), "outside");
  await symlink(join(f.temp, "private.txt"), join(f.root, "outside.txt"));
  await symlink(join(f.root, ".git"), join(f.root, "git-alias"), "dir");
  for (const path of [f.root, "../private.txt", "child/../hello.txt", ".git/config", "git-alias/config",
    "outside.txt", "C:/outside", "..\\private.txt", "bad\0path"]) {
    await assert.rejects(service.read({ path }), (error: unknown) => error instanceof FileServiceError &&
      (error.status === 400 || error.status === 403));
  }
  await assert.rejects(service.read({ path: "missing" }), (error: unknown) =>
    error instanceof FileServiceError && error.status === 404);
  await assert.rejects(service.read({ path: "." }), (error: unknown) =>
    error instanceof FileServiceError && error.status === 400);
  await symlink(join(f.root, "hello.txt"), join(f.root, "inside.txt"));
  assert.equal((await service.read({ path: "inside.txt" })).content, "first line\nneedle second\n");
});

test("binary and large reads are explicit and hashes cover the complete bytes", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths, boundary: { async execute() { throw new Error("unexpected"); } },
  });
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 255, 1]));
  const binary = await service.read({ path: "binary.bin" });
  assert.equal(binary.binary, true);
  assert.equal(binary.content, "");
  await writeFile(join(f.root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  assert.equal((await service.read({ path: "invalid.txt" })).binary, true);
  const large = "x".repeat(1_048_576) + "last bytes";
  await writeFile(join(f.root, "large.txt"), large);
  const read = await service.read({ path: "large.txt" });
  assert.equal(read.truncated, true);
  assert.equal(read.size, Buffer.byteLength(large));
  assert.equal(read.hash, sha256Hex(large));
  assert.ok(Buffer.byteLength(read.content) <= 1_048_576);
});

test("tree pagination exposes fresh Git status and never exposes Git internals", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths, boundary: { async execute() { throw new Error("unexpected"); } },
  });
  await writeFile(join(f.root, "hello.txt"), "changed\n");
  await writeFile(join(f.root, "new.txt"), "new\n");
  const first = await service.tree({ limit: 1 });
  assert.deepEqual(first.entries, [{ path: "hello.txt", name: "hello.txt", kind: "file", size: 8, gitStatus: " M" }]);
  assert.equal(first.nextOffset, 1);
  const second = await service.tree({ offset: first.nextOffset!, limit: 1 });
  assert.equal(second.entries[0]?.gitStatus, "??");
  assert.equal(second.nextOffset, null);
  assert.deepEqual((await service.tree({ offset: 99 })).entries, []);
  await assert.rejects(service.tree({ path: "../", limit: 1 }), (error: unknown) => error instanceof FileServiceError);
  await assert.rejects(service.tree({ limit: 0 }), (error: unknown) => error instanceof FileServiceError);
});

test("search returns literal line references with bounded results and ignores outside symlinks", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths, boundary: { async execute() { throw new Error("unexpected"); } },
  });
  await writeFile(join(f.temp, "outside.txt"), "needle outside");
  await symlink(join(f.temp, "outside.txt"), join(f.root, "outside.txt"));
  assert.deepEqual(await service.search({ q: "needle" }), {
    results: [{ path: "hello.txt", line: 2, text: "needle second" }], truncated: false,
  });
  assert.deepEqual((await service.search({ q: "[literal]" })).results, []);
  await writeFile(join(f.root, "many.txt"), "needle\n".repeat(205));
  const result = await service.search({ q: "needle" });
  assert.equal(result.results.length, 200);
  assert.equal(result.truncated, true);
  await assert.rejects(service.search({ q: "" }), (error: unknown) => error instanceof FileServiceError);
});

test("write binds exact parameters, retains original bytes and mode, and undoes across instances", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileConflictError } = await import("../src/files/service.ts");
  const requests: unknown[] = [];
  let inside = false;
  const boundary = {
    async execute<T>(request: unknown, effect: () => Promise<T>): Promise<T> {
      requests.push(request);
      assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), requests.length === 1 ?
        "first line\nneedle second\n" : "human edit\n");
      inside = true;
      try { return await effect(); } finally { inside = false; }
    },
  };
  await chmod(join(f.root, "hello.txt"), 0o755);
  const service = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const before = await service.read({ path: "hello.txt" });
  const changed = await service.mutate({
    operation: "write", path: "hello.txt", content: "human edit\n", expectedHash: before.hash,
  });
  assert.equal(inside, false);
  assert.equal(changed.hash, sha256Hex("human edit\n"));
  assert.equal(changed.artifactId, `art_${before.hash}`);
  assert.deepEqual(changed.changedPaths, ["hello.txt"]);
  const request = requests[0] as { operation: string; parameters: Record<string, unknown> };
  assert.equal(request.operation, "write");
  assert.equal(request.parameters["expectedHash"], before.hash);
  assert.equal(request.parameters["content"], "human edit\n");
  assert.equal(request.parameters["artifactId"], changed.artifactId);
  assert.equal(request.parameters["mutationId"], changed.mutationId);
  assert.equal((await stat(join(f.root, "hello.txt"))).mode & 0o777, 0o755);
  const second = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const undone = await second.mutate({
    operation: "undo", path: "hello.txt", mutationId: changed.mutationId, expectedHash: changed.hash,
  });
  assert.equal(undone.hash, before.hash);
  assert.equal(undone.artifactId, `art_${changed.hash}`);
  assert.equal(await readFile(join(f.paths.artifactsDir, changed.hash!.slice(0, 2), changed.hash!), "utf8"), "human edit\n");
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), before.content);
  assert.equal((await stat(join(f.root, "hello.txt"))).mode & 0o777, 0o755);
  await assert.rejects(second.mutate({
    operation: "undo", path: "hello.txt", mutationId: changed.mutationId, expectedHash: before.hash,
  }), FileConflictError);
});

test("denied and stale mutations perform no writes; hashes are rechecked after authorization", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileConflictError, FileServiceError } = await import("../src/files/service.ts");
  const refused = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths,
    boundary: { async execute() { throw new FileServiceError("denied", 403); } },
  });
  const before = await refused.read({ path: "hello.txt" });
  await assert.rejects(refused.mutate({
    operation: "write", path: "hello.txt", expectedHash: before.hash, content: "denied\n",
  }), (error: unknown) => error instanceof FileServiceError && error.status === 403);
  await assert.rejects(access(f.paths.home), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), before.content);
  let called = 0;
  const raced = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths,
    boundary: {
      async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> {
        called += 1;
        await writeFile(join(f.root, "hello.txt"), "agent intervened\n");
        return effect();
      },
    },
  });
  await assert.rejects(raced.mutate({
    operation: "write", path: "hello.txt", expectedHash: before.hash, content: "stale\n",
  }), FileConflictError);
  assert.equal(called, 1);
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "agent intervened\n");
  await assert.rejects(raced.mutate({
    operation: "write", path: "hello.txt", expectedHash: before.hash, content: "stale\n",
  }), FileConflictError);
  assert.equal(called, 1);
});

test("create, rename, delete and undo never clobber existing or later edits", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileConflictError } = await import("../src/files/service.ts");
  let authorizations = 0;
  const boundary = { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> {
    authorizations += 1;
    return effect();
  } };
  const service = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const created = await service.mutate({ operation: "create", path: "new.txt", content: "new\n" });
  await assert.rejects(service.mutate({ operation: "create", path: "new.txt", content: "clobber" }), FileConflictError);
  assert.equal(authorizations, 1);
  await writeFile(join(f.root, "destination.txt"), "existing user edit\n");
  await assert.rejects(service.mutate({
    operation: "rename", path: "new.txt", destination: "destination.txt", expectedHash: created.hash!,
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "destination.txt"), "utf8"), "existing user edit\n");
  const renamed = await service.mutate({
    operation: "rename", path: "new.txt", destination: "renamed.txt", expectedHash: created.hash!,
  });
  await assert.rejects(access(join(f.root, "new.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "renamed.txt"), "utf8"), "new\n");
  await writeFile(join(f.root, "new.txt"), "new user file\n");
  await assert.rejects(service.mutate({
    operation: "undo", path: "new.txt", mutationId: renamed.mutationId, expectedHash: renamed.hash,
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "new user file\n");
  await rm(join(f.root, "new.txt"));
  await service.mutate({ operation: "undo", path: "new.txt", mutationId: renamed.mutationId, expectedHash: renamed.hash });
  const deleted = await service.mutate({ operation: "delete", path: "new.txt", expectedHash: created.hash! });
  assert.equal(deleted.hash, null);
  await writeFile(join(f.root, "new.txt"), "agent replacement\n");
  await assert.rejects(service.mutate({
    operation: "undo", path: "new.txt", mutationId: deleted.mutationId, expectedHash: null,
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "agent replacement\n");
  await rm(join(f.root, "new.txt"));
  await service.mutate({ operation: "undo", path: "new.txt", mutationId: deleted.mutationId, expectedHash: null });
  await writeFile(join(f.root, "new.txt"), "agent modified created file\n");
  await assert.rejects(service.mutate({
    operation: "undo", path: "new.txt", mutationId: created.mutationId, expectedHash: sha256Hex("agent modified created file\n"),
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "agent modified created file\n");
  await writeFile(join(f.root, "new.txt"), "new\n");
  await service.mutate({ operation: "undo", path: "new.txt", mutationId: created.mutationId, expectedHash: created.hash });
  await assert.rejects(access(join(f.root, "new.txt")), { code: "ENOENT" });
});

test("mutations reject unsupported data, directory removal and escaped paths before authorization", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError } = await import("../src/files/service.ts");
  const service = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths, boundary: { async execute() { throw new Error("must reject before authority"); } },
  });
  const original = await service.read({ path: "hello.txt" });
  await mkdir(join(f.root, "directory"));
  await writeFile(join(f.root, "directory", "keep.txt"), "keep");
  await symlink(join(f.root, "hello.txt"), join(f.root, "alias.txt"));
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 255]));
  await writeFile(join(f.root, "large.txt"), "x".repeat(2_000_001));
  for (const path of ["../outside", ".git/config", ".", "alias.txt", "directory", "binary.bin", "large.txt"]) {
    await assert.rejects(service.mutate({ operation: "delete", path, expectedHash: original.hash }), FileServiceError);
  }
  await assert.rejects(service.mutate({
    operation: "write", path: "hello.txt", expectedHash: original.hash, content: "x".repeat(2_000_001),
  }), (error: unknown) => error instanceof FileServiceError && error.status === 413);
  await assert.rejects(service.mutate({ operation: "create", path: "bad.txt", content: "a\0b" }),
    (error: unknown) => error instanceof FileServiceError && error.status === 415);
  assert.equal(await readFile(join(f.root, "directory", "keep.txt"), "utf8"), "keep");
  await assert.rejects(access(f.paths.home), { code: "ENOENT" });
});

test("two service instances with stale hashes have only one successful writer", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileConflictError } = await import("../src/files/service.ts");
  const boundary = { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> { return effect(); } };
  const a = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const b = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const before = await a.read({ path: "hello.txt" });
  const results = await Promise.allSettled([
    a.mutate({ operation: "write", path: "hello.txt", expectedHash: before.hash, content: "a\n" }),
    b.mutate({ operation: "write", path: "hello.txt", expectedHash: before.hash, content: "b\n" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof FileConflictError);
  assert.ok(["a\n", "b\n"].includes(await readFile(join(f.root, "hello.txt"), "utf8")));
});

test("authorization waits cannot replace a destination or redirect a parent through a symlink", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError, FileConflictError } = await import("../src/files/service.ts");
  await mkdir(join(f.root, "parent"));
  const outside = join(f.temp, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "private");
  const swapParent = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths,
    boundary: { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> {
      await rm(join(f.root, "parent"), { recursive: true });
      await symlink(outside, join(f.root, "parent"), "dir");
      return effect();
    } },
  });
  await assert.rejects(swapParent.mutate({ operation: "create", path: "parent/new.txt", content: "escape" }),
    (error: unknown) => error instanceof FileServiceError && error.status === 403);
  await assert.rejects(access(join(outside, "new.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "private");
  const replaceDestination = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths,
    boundary: { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> {
      await writeFile(join(f.root, "new.txt"), "user created during wait");
      return effect();
    } },
  });
  await assert.rejects(replaceDestination.mutate({ operation: "create", path: "new.txt", content: "stale" }), FileConflictError);
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "user created during wait");
  const before = await replaceDestination.read({ path: "hello.txt" });
  await assert.rejects(replaceDestination.mutate({
    operation: "rename", path: "hello.txt", destination: "new.txt", expectedHash: before.hash,
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), before.content);
});

test("undo validates compensating artifact integrity and rechecks later edits after authority", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileConflictError, FileServiceError } = await import("../src/files/service.ts");
  const boundary = { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> { return effect(); } };
  const service = new FileWorkspaceService({ rootPath: f.root, paths: f.paths, boundary });
  const before = await service.read({ path: "hello.txt" });
  const changed = await service.mutate({
    operation: "write", path: "hello.txt", content: "human\n", expectedHash: before.hash,
  });
  const raced = new FileWorkspaceService({
    rootPath: f.root, paths: f.paths,
    boundary: { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> {
      await writeFile(join(f.root, "hello.txt"), "new agent edit");
      return effect();
    } },
  });
  await assert.rejects(raced.mutate({
    operation: "undo", path: "hello.txt", mutationId: changed.mutationId, expectedHash: changed.hash,
  }), FileConflictError);
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "new agent edit");
  await writeFile(join(f.root, "hello.txt"), "human\n");
  await writeFile(join(f.paths.artifactsDir, before.hash.slice(0, 2), before.hash), "tampered");
  await assert.rejects(service.mutate({
    operation: "undo", path: "hello.txt", mutationId: changed.mutationId, expectedHash: changed.hash,
  }), (error: unknown) => error instanceof FileServiceError && error.code === "mutation_artifact_invalid");
  assert.equal(await readFile(join(f.root, "hello.txt"), "utf8"), "human\n");
});

test("file service rejects stores inside the workspace, including symlink aliases", async (t) => {
  const f = await fixture(t);
  const { FileWorkspaceService, FileServiceError } = await import("../src/files/service.ts");
  const boundary = { async execute<T>(_request: unknown, effect: () => Promise<T>): Promise<T> { return effect(); } };
  const assertStoreRejected = (paths: ReturnType<typeof resolveKeystonePaths>) =>
    assert.throws(() => new FileWorkspaceService({ rootPath: f.root, paths, boundary }), FileServiceError);
  assertStoreRejected(resolveKeystonePaths(join(f.root, "store")));
  await symlink(f.root, join(f.temp, "alias"), "dir");
  assertStoreRejected(resolveKeystonePaths(join(f.temp, "alias", "store")));
  assertStoreRejected({ ...f.paths, artifactsDir: join(f.root, "artifacts") });
});
