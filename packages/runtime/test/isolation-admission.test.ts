import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { KernelSession } from "@keystone/kernel";
import { join } from "node:path";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { removeIsolatedWorkspace } from "../src/isolation.ts";
import { autonomyFor, envelopeFor, FINISH_ACTION, makeFixture, removeFixture, run } from "./fixture.ts";

test("unapproved isolated tasks do not create a Git worktree", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({ name: "no-test-command", version: "1.0.0" }));
    const before = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, mode: "isolated", models: [] });
    const result = await runtime.runTask({ workspacePath: fixture.root, request: "investigate project",
      autonomy: autonomyFor([]) });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.isolatedWorkspace, undefined);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout, before);
  } finally { await removeFixture(fixture); }
});

test("isolated workspace creation is preceded by a parameter-bound kernel lease", async () => {
  const fixture = await makeFixture();
  let workspace: string | undefined;
  try {
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, mode: "isolated", models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([FINISH_ACTION])] }),
    ] });
    const result = await runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
      acceptContractAutomatically: true });
    workspace = result.isolatedWorkspace;
    assert.ok(workspace);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const lease = session.events().find((event) => event.type === "lease.issued" &&
      (event.payload.subject as { id?: string })?.id === "runtime.isolation");
    assert.ok(lease, "provisioning must have a kernel-issued lease");
    assert.equal(lease.payload.capability, "git.write");
    assert.equal(typeof (lease.payload.constraints as { parametersHash: string }).parametersHash, "string");
    assert.ok(session.events().some((event) => event.type === "lease.consumed" && event.payload.leaseId === lease.payload.leaseId));
    assert.ok((await readFile(fixture.paths.ledgerFile(result.taskId), "utf8")).includes("runtime.isolation"));
  } finally {
    if (workspace) await removeIsolatedWorkspace(fixture.root, workspace);
    await removeFixture(fixture);
  }
});
