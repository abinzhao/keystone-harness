import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { appendEvent, buildEvent, chainTip, resolveKeystonePaths } from "@keystone/kernel";
import { newId, type ProjectId, type RunEvent, type TaskId } from "@keystone/schemas";
import * as data from "../src/data.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "keystone-data-management-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repository");
  const home = join(base, "store");
  await mkdir(root);
  await mkdir(home);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "code.ts"), "export const original = true;\n");
  const paths = resolveKeystonePaths(home);
  const destination = join(base, "migrated");
  return { base, root, home, paths, destination };
}

async function put(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function task(paths: ReturnType<typeof resolveKeystonePaths>, stopped = false, projectId: ProjectId = newId("proj") as ProjectId) {
  const taskId = newId("task") as TaskId;
  const branchId = newId("branch");
  const events: RunEvent[] = [];
  const push = async (type: Parameters<typeof buildEvent>[0]["type"], payload: Record<string, unknown>) => {
    const event = buildEvent({ taskId, branchId, type, payload, actorKind: "kernel", actorId: "test" }, chainTip(events));
    events.push(event);
    await appendEvent(paths.ledgerFile(taskId), event);
  };
  await push("task.created", { projectId, request: "data fixture", requestedBy: "cli", references: [] });
  if (stopped) await push("task.status_changed", { from: "draft", to: "stopped", event: "task.stopped" });
  return { taskId, projectId };
}

async function management() {
  const url = new URL("../src/data-management.ts", import.meta.url);
  const module = await import(url.href).catch(() => undefined);
  assert.equal(typeof module?.previewCleanup, "function", "previewCleanup must be exported");
  assert.equal(typeof module?.migrateData, "function", "migrateData must be exported");
  return module as typeof import("../src/data-management.ts");
}

function refusal(code: string, status = 409) {
  return (error: unknown) => {
    assert.ok(error instanceof data.DataError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test("inventory counts the whole home and attachments without reading credential contents", async (t) => {
  const f = await fixture(t);
  const digest = "a".repeat(64);
  const values = [
    [join(f.paths.credentialsDir, "example-key.json"), "NOT_A_JSON_SECRET_PLACEHOLDER"],
    [f.paths.configFile, JSON.stringify({ models: [{ credentialHandle: "keychain-handle" }] })],
    [join(f.home, "presentation.json"), '{"theme":"dark"}'],
    [join(f.home, "inputs", "attachment.example.json"), JSON.stringify({ artifactId: `art_${digest}` })],
    [join(f.paths.artifactsDir, "aa", digest), "image-bytes"],
    [join(f.paths.cacheDir, "context.bin"), "cache"],
    [join(f.paths.indexDir, "lookup.bin"), "index"],
    [join(f.paths.proofsDir, "unused.json"), "{}"],
    [join(f.home, "unknown-metadata.bin"), "extra"],
  ] as const;
  for (const [path, value] of values) await put(path, value);
  const inventory = await data.storeInventory(f.paths);
  assert.deepEqual(inventory.totals, { files: values.length, bytes: values.reduce((n, [, value]) => n + Buffer.byteLength(value), 0) });
  assert.deepEqual(inventory.credentials, { files: 1, bytes: Buffer.byteLength(values[0][1]), handles: ["example-key", "keychain-handle"] });
  assert.deepEqual(inventory.settings, { files: 2, bytes: Buffer.byteLength(values[1][1]) + Buffer.byteLength(values[2][1]) });
  assert.deepEqual(inventory.attachments, { files: 2, bytes: Buffer.byteLength(values[3][1]) + Buffer.byteLength(values[4][1]) });
  assert.deepEqual(inventory.history, { files: 0, bytes: 0 });
  assert.deepEqual(inventory.derived.cache, { files: 1, bytes: 5 });
  assert.ok(!JSON.stringify(inventory).includes("NOT_A_JSON_SECRET_PLACEHOLDER"));
});

test("experience clearing refuses an active project and preserves all records", async (t) => {
  const f = await fixture(t);
  const active = await task(f.paths);
  const file = f.paths.experienceEntriesFile(active.projectId);
  await put(file, '{"entryId":"example"}\n');
  await assert.rejects(data.clearProjectExperience(f.paths, active.projectId), refusal("task_active"));
  assert.equal(await readFile(file, "utf8"), '{"entryId":"example"}\n');
});

test("experience clearing refuses frozen or user-confirmed rules and never removes facts", async (t) => {
  const f = await fixture(t);
  for (const record of [{ frozen: true }, { status: "frozen" }, { promotedBy: "user_confirmation" }]) {
    const projectId = newId("proj") as ProjectId;
    const file = f.paths.experienceEntriesFile(projectId);
    const text = `${JSON.stringify(record)}\n`;
    await put(file, text);
    await put(f.paths.factsFile(projectId), '{"userRule":"must remain"}\n');
    await assert.rejects(data.clearProjectExperience(f.paths, projectId), refusal("protected_data"));
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal(await readFile(f.paths.factsFile(projectId), "utf8"), '{"userRule":"must remain"}\n');
  }
});

test("ordinary experience can be cleared when only a different project has an active task", async (t) => {
  const f = await fixture(t);
  await task(f.paths);
  const projectId = newId("proj") as ProjectId;
  await put(f.paths.experienceEntriesFile(projectId), '{"frozen":false,"promotedBy":"independent_verification"}\n');
  await put(f.paths.factsFile(projectId), "{}\n");
  assert.equal((await data.clearProjectExperience(f.paths, projectId)).entries, 1);
  assert.equal(await readFile(f.paths.factsFile(projectId), "utf8"), "{}\n");
});

test("cleanup previews exact derived impact and never touches repository or original artifacts", async (t) => {
  const f = await fixture(t);
  const m = await management();
  for (const category of ["cache", "index", "proofs"] as const) {
    const dir = join(f.home, category);
    await put(join(dir, "nested", "unreferenced.bin"), "abc");
    const preview = await m.previewCleanup(f.paths, { category, preview: true });
    assert.deepEqual(preview, { category, files: 1, bytes: 3, preview: true });
    assert.equal(await readFile(join(dir, "nested", "unreferenced.bin"), "utf8"), "abc");
    assert.deepEqual(await m.previewCleanup(f.paths, { category, preview: false }), { ...preview, preview: false, removed: true });
  }
  await put(join(f.paths.artifactsDir, "original.bin"), "original");
  assert.equal(await readFile(join(f.root, "code.ts"), "utf8"), "export const original = true;\n");
  await assert.rejects(m.previewCleanup(f.paths, { category: "artifacts" as never, preview: false }), refusal("invalid_options", 400));
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: undefined as never }), refusal("invalid_options", 400));
  assert.equal(await readFile(join(f.paths.artifactsDir, "original.bin"), "utf8"), "original");
});

test("cleanup refuses every nonterminal or unverifiable task, including previews, with impact", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.cacheDir, "candidate.bin"), "abc");
  const active = await task(f.paths);
  const check = (error: unknown) => {
    refusal("task_active")(error);
    assert.deepEqual((error as data.DataError).impact, { category: "cache", files: 1, bytes: 3, preview: true });
    return true;
  };
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: true }), check);
  await put(f.paths.ledgerFile(active.taskId), "broken\n");
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: true }), check);
  await put(f.paths.ledgerFile(active.taskId), "");
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: true }), check);
  assert.equal(await readFile(join(f.paths.cacheDir, "candidate.bin"), "utf8"), "abc");
});

test("cleanup refuses checkpoint/proof references and protected rules without partial removal", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const ended = await task(f.paths, true);
  const digest = "b".repeat(64);
  await put(join(f.paths.cacheDir, digest), "referenced");
  await put(join(f.paths.cacheDir, "unreferenced.bin"), "leave-on-refusal");
  await put(join(f.paths.checkpointsDir(ended.taskId), "checkpoint.json"), JSON.stringify({ artifactRefs: [`art_${digest}`] }));
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: false }), refusal("referenced_data"));
  assert.equal(await readFile(join(f.paths.cacheDir, "unreferenced.bin"), "utf8"), "leave-on-refusal");
  await put(join(f.paths.proofsDir, ended.taskId, "proof_example.json"), "{}");
  await put(join(f.paths.checkpointsDir(ended.taskId), "checkpoint.json"), JSON.stringify({ proofPath: `proofs/${ended.taskId}/proof_example.json` }));
  await assert.rejects(m.previewCleanup(f.paths, { category: "proofs", preview: false }), refusal("referenced_data"));
  await put(join(f.paths.indexDir, "rules.json"), '{"nested":{"promotedBy":"user_confirmation"}}');
  await assert.rejects(m.previewCleanup(f.paths, { category: "index", preview: false }), refusal("protected_data"));
});

test("symlink escapes are refused for inventory, cleanup, history and experience", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await symlink(f.root, f.paths.cacheDir, "dir");
  await assert.rejects(data.storeInventory(f.paths), refusal("unsafe_path", 400));
  await assert.rejects(m.previewCleanup(f.paths, { category: "cache", preview: false }), refusal("unsafe_path", 400));
  const projectId = newId("proj") as ProjectId;
  await mkdir(f.paths.projectsDir, { recursive: true });
  await symlink(f.root, f.paths.projectDir(projectId), "dir");
  await assert.rejects(data.clearProjectExperience(f.paths, projectId), refusal("unsafe_path", 400));
  const taskId = newId("task") as TaskId;
  await mkdir(f.paths.tasksDir, { recursive: true });
  await symlink(f.root, f.paths.taskDir(taskId), "dir");
  await assert.rejects(data.deleteTaskHistory(f.paths, taskId), refusal("unsafe_path", 400));
  assert.equal(await readFile(join(f.root, "code.ts"), "utf8"), "export const original = true;\n");
});

test("migration preview is read-only; verified migration preserves source and ignores transient locks", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const ended = await task(f.paths, true);
  await put(join(f.home, "presentation.json"), '{"theme":"dark"}');
  await put(join(f.paths.cacheDir, "binary"), Uint8Array.from([0, 1, 2, 255]));
  await put(f.paths.taskLockFile(ended.taskId), "stale fixture lock");
  await put(join(f.home, "settings.lock"), "stale fixture lock");
  await put(join(f.paths.cacheDir, "dependency.lock"), "retained content");
  const before = await readFile(f.paths.ledgerFile(ended.taskId));
  const preview = await m.migrateData(f.paths, { destination: f.destination, preview: true });
  assert.equal(preview.preview, true);
  assert.equal(preview.verified, false);
  assert.equal(preview.newHome, undefined);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  const migrated = await m.migrateData(f.paths, { destination: f.destination, preview: false });
  assert.equal(migrated.verified, true);
  assert.equal(migrated.newHome, f.destination);
  assert.equal(migrated.destination, f.destination);
  assert.equal(migrated.sourcePreserved, true);
  assert.deepEqual(await readFile(join(f.destination, "tasks", ended.taskId, "ledger.jsonl")), before);
  assert.deepEqual(await readFile(f.paths.ledgerFile(ended.taskId)), before);
  assert.deepEqual(await readFile(join(f.destination, "cache", "binary")), Buffer.from([0, 1, 2, 255]));
  assert.equal(await readFile(join(f.destination, "cache", "dependency.lock"), "utf8"), "retained content");
  await assert.rejects(lstat(join(f.destination, "settings.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.destination, "tasks", ended.taskId, "task.lock")), { code: "ENOENT" });
  assert.equal(await readFile(f.paths.taskLockFile(ended.taskId), "utf8"), "stale fixture lock");
  assert.deepEqual((await readdir(f.base)).sort(), ["migrated", "repository", "store"]);
});

test("migration preserves a secret-free credential service across repeated moves", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const service = `net.keystone.credentials.${createHash("sha256").update(f.paths.credentialsDir).digest("hex").slice(0, 32)}`;
  assert.equal(await m.readCredentialService(f.paths), service);
  const moved = await m.migrateData(f.paths, { destination: f.destination, preview: false });
  assert.equal(moved.credentialService, service);
  const next = resolveKeystonePaths(moved.newHome!);
  assert.equal(await m.readCredentialService(next), service);
  const again = await m.migrateData(next, { destination: join(f.base, "second-move"), preview: false });
  assert.equal(again.credentialService, service);
  const metadata = JSON.parse(await readFile(join(f.destination, "credential-service.json"), "utf8"));
  assert.deepEqual(metadata, { version: "1.0.0", service });
});

test("migration refuses existing destinations, source overlaps and repository overlaps", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const projectId = newId("proj") as ProjectId;
  await put(join(f.paths.projectsDir, "registry.json"), JSON.stringify({ version: "1.0.0", projects: [{ projectId, rootPath: f.root }] }));
  for (const destination of [f.home, join(f.home, "child"), f.base, f.root, join(f.root, "child")]) {
    await assert.rejects(m.migrateData(f.paths, { destination, preview: false }), refusal("overlap"));
  }
  await mkdir(f.destination);
  await put(join(f.destination, "keep.bin"), "existing");
  await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }), refusal("destination_exists"));
  assert.equal(await readFile(join(f.destination, "keep.bin"), "utf8"), "existing");
  await symlink(f.root, join(f.base, "repository-alias"), "dir");
  await assert.rejects(m.migrateData(f.paths, { destination: join(f.base, "repository-alias", "child"), preview: true }), refusal("overlap"));
  assert.equal(await readFile(join(f.root, "code.ts"), "utf8"), "export const original = true;\n");
});

test("migration checks old project profiles as well as registry roots", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const projectId = newId("proj") as ProjectId;
  await put(f.paths.projectFile(projectId), JSON.stringify({ rootPath: f.root }));
  await assert.rejects(m.migrateData(f.paths, { destination: join(f.root, "nested"), preview: false }), refusal("overlap"));
});

test("migration refuses active/unknown tasks and symlinks, without creating destination", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const active = await task(f.paths);
  await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: true }), refusal("task_active"));
  await put(f.paths.ledgerFile(active.taskId), "broken\n");
  await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }), refusal("task_active"));
  await rm(f.paths.taskDir(active.taskId), { recursive: true });
  await symlink(join(f.root, "code.ts"), join(f.home, "escaped-file"));
  await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }), refusal("unsafe_path", 400));
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("migration refuses legacy credentials without reading, exporting or changing them", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const path = join(f.paths.credentialsDir, "legacy-handle.json");
  await put(path, "NOT_A_JSON_SECRET_PLACEHOLDER");
  await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }), refusal("credentials_require_migration"));
  assert.equal(await readFile(path, "utf8"), "NOT_A_JSON_SECRET_PLACEHOLDER");
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("cleanup honors references from another proof in the derived proof directory", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.proofsDir, "proof_source.json"), '{"proofId":"proof_source"}');
  await put(join(f.paths.proofsDir, "proof_dependent.json"), '{"parentProofId":"proof_source"}');
  await assert.rejects(m.previewCleanup(f.paths, { category: "proofs", preview: false }), refusal("referenced_data"));
  assert.equal(await readFile(join(f.paths.proofsDir, "proof_source.json"), "utf8"), '{"proofId":"proof_source"}');
});

test("experience clearing refuses malformed and torn records with a typed status", async (t) => {
  const f = await fixture(t);
  for (const content of ["malformed\n", '{"frozen":true}']) {
    const projectId = newId("proj") as ProjectId;
    await put(f.paths.experienceEntriesFile(projectId), content);
    await assert.rejects(data.clearProjectExperience(f.paths, projectId), refusal("protected_data"));
    assert.equal(await readFile(f.paths.experienceEntriesFile(projectId), "utf8"), content);
  }
});

test("cleanup rejects a derived-directory alias pointing at original artifacts", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.artifactsDir, "original.bin"), "unchanged");
  await assert.rejects(m.previewCleanup({ ...f.paths, cacheDir: f.paths.artifactsDir }, { category: "cache", preview: false }), refusal("unsafe_path", 400));
  assert.equal(await readFile(join(f.paths.artifactsDir, "original.bin"), "utf8"), "unchanged");
});

test("unreferenced proofs can be removed despite carrying their own identity", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.proofsDir, "proof_self.json"), '{"proofId":"proof_self"}');
  assert.equal((await m.previewCleanup(f.paths, { category: "proofs", preview: false })).removed, true);
});

test("migration verifies sorted manifests and reports the actual destination size", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.cacheDir, "z-last"), "last");
  await put(join(f.paths.cacheDir, "a-first"), "first");
  const moved = await m.migrateData(f.paths, { destination: f.destination, preview: false });
  const files = await data.listStoreFiles(resolveKeystonePaths(moved.newHome!));
  const entries = [];
  for (const file of files) entries.push({
    path: file.path.slice(moved.newHome!.length + 1), bytes: file.bytes,
    hash: createHash("sha256").update(await readFile(file.path)).digest("hex"),
  });
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(moved.manifestHash, createHash("sha256").update(JSON.stringify(entries)).digest("hex"));
  assert.equal(moved.bytes, files.reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(moved.files, files.length);
});

test("migration rejects corrupted copies and source changes and removes only its staging data", async (t) => {
  const f = await fixture(t);
  const m = await management();
  const sourceFile = join(f.paths.cacheDir, "content.bin");
  await put(sourceFile, "original");
  const originalCopy = fsPromises.copyFile;
  for (const kind of ["copy", "source"] as const) {
    const replacement = t.mock.method(fsPromises, "copyFile", async (...args: Parameters<typeof originalCopy>) => {
      await originalCopy(...args);
      await writeFile(kind === "copy" ? args[1] : args[0], "modified");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }),
        refusal(kind === "copy" ? "verification_failed" : "source_changed"));
      await assert.rejects(lstat(f.destination), { code: "ENOENT" });
      assert.deepEqual((await readdir(f.base)).sort(), ["repository", "store"]);
      assert.equal(await readFile(sourceFile, "utf8"), kind === "copy" ? "original" : "modified");
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("migration preserves a destination created during copy rather than overwriting it", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await put(join(f.paths.cacheDir, "source.bin"), "source");
  const originalCopy = fsPromises.copyFile;
  const replacement = t.mock.method(fsPromises, "copyFile", async (...args: Parameters<typeof originalCopy>) => {
    await originalCopy(...args);
    await put(join(f.destination, "keep.bin"), "racing destination");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(m.migrateData(f.paths, { destination: f.destination, preview: false }), refusal("destination_exists"));
    assert.equal(await readFile(join(f.destination, "keep.bin"), "utf8"), "racing destination");
    assert.deepEqual((await readdir(f.base)).sort(), ["migrated", "repository", "store"]);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});

test("migration of a missing source is refused instead of inventing a new data home", async (t) => {
  const f = await fixture(t);
  const m = await management();
  await assert.rejects(m.migrateData(resolveKeystonePaths(join(f.base, "missing")),
    { destination: f.destination, preview: false }), refusal("not_found", 404));
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});
