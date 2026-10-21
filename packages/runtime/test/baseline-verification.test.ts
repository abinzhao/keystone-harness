import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { artifactPath, digestFromArtifactId, getArtifactBytes, KernelSession } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { compareBaselineCandidate } from "../src/baseline-verification.ts";
import { createIsolatedWorkspace, removeIsolatedWorkspace } from "../src/isolation.ts";
import { observeWorkspace } from "../src/workspace-observation.ts";
import { autonomyFor, BUGGY_SESSION, envelopeFor, FIXED_SESSION, FINISH_ACTION,
  makeFixture, removeFixture, run, SESSION_TEST, writeAction, type Fixture } from "./fixture.ts";

async function finishTask(fixture: Fixture, fix = true, directoryScope = false) {
  const descriptor = scriptedModelDescriptor({ id: "comparison-fixture" });
  const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
    createSequenceAdapter({ descriptor, responses: [
      envelopeFor(fix ? [writeAction("src/auth/session.js", FIXED_SESSION)] : [FINISH_ACTION]),
      envelopeFor([FINISH_ACTION]),
    ] }),
  ] });
  return runtime.runTask({ workspacePath: fixture.root, request: "fix src/auth/session.js",
    references: [{ kind: directoryScope ? "directory" : "file", value: directoryScope ? "src/auth" : "src/auth/session.js" }],
    autonomy: autonomyFor(["src/auth/**"]), acceptContractAutomatically: true, maxSteps: 2 });
}

test("fresh comparison observes baseline failure and candidate pass without reusing parent proof", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    assert.equal(result.status, "proven");
    const parentLedger = await readFile(fixture.paths.ledgerFile(result.taskId), "utf8");
    const parent = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const evidence = await parent.evidence();
    const before = await observeWorkspace(fixture.root);
    const worktrees = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "observed", report.reason);
    assert.equal(report.verdict, "baseline_failed_candidate_passed", report.reason);
    assert.notEqual(report.comparisonTaskId, result.taskId);
    assert.equal(report.parentProofReused, false);
    assert.equal(report.evidenceLevel, null);
    assert.deepEqual(report.evidenceIds, []);
    assert.equal(report.variants.length, 2);
    assert.equal(report.variants[0]?.checks[0]?.status, "failed");
    assert.equal(report.variants[1]?.checks[0]?.status, "passed");
    assert.ok(report.variants.every((variant) => variant.contentEquivalent && variant.unchangedAfterExecution));
    assert.equal(report.binding?.protectedTestsUnchanged, true);
    assert.ok(report.budget.wallClockMs > 0);
    assert.equal(await readFile(fixture.paths.ledgerFile(result.taskId), "utf8"), parentLedger);
    assert.deepEqual(await parent.evidence(), evidence);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout, worktrees);
    const comparison = await KernelSession.open({ paths: fixture.paths, taskId: report.comparisonTaskId! });
    assert.equal(comparison.state().status, "stopped");
    assert.ok(comparison.contract()!.completionConditions.every((condition) => condition.required));
    assert.deepEqual(await comparison.evidence(), []);
    const issued = comparison.events().filter((event) => event.type === "lease.issued");
    const consumed = comparison.events().filter((event) => event.type === "lease.consumed");
    assert.equal(issued.length, consumed.length);
    assert.ok(issued.length >= 7);
    assert.equal(new Set(consumed.map((event) => event.payload.leaseId)).size, consumed.length);
    assert.ok(issued.some((event) => event.payload.capability === "fs.write"));
    assert.equal(issued.filter((event) => event.payload.capability === "cmd.exec").length, 2);
    assert.ok(comparison.events().filter((event) => event.type === "budget.consumed")
      .every((event) => event.payload.measured === true));
    assert.ok(report.artifactRefs.length > 0);
    for (const ref of report.artifactRefs) assert.ok(await getArtifactBytes(fixture.paths, ref));
  } finally { await removeFixture(fixture); }
});

test("modified protected tests are blocked before execution and never restored into the source", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    await writeFile(join(fixture.root, "test/session.test.js"), SESSION_TEST.replace("1);", "2);"));
    const before = await observeWorkspace(fixture.root);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /protected/i);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal(report.verdict, "inconclusive");
    assert.equal(report.variants.length, 0);
  } finally { await removeFixture(fixture); }
});

test("missing initial historical capsule is blocked, never replaced with HEAD", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    const parent = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const checkpoint = parent.events().find((event) => event.type === "checkpoint.created")!;
    const refs = checkpoint.payload.artifactRefs as string[];
    for (const ref of refs) {
      const bytes = await getArtifactBytes(fixture.paths, ref);
      if (bytes && JSON.parse(Buffer.from(bytes).toString()).version === "keystone.workspace-recovery/1") {
        await rm(artifactPath(fixture.paths, digestFromArtifactId(ref)));
      }
    }
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /artifact|capsule/i);
    assert.equal(report.variants.length, 0);
  } finally { await removeFixture(fixture); }
});

test("unadmitted ordinary dirty files and staged index changes fail closed", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    await writeFile(join(fixture.root, "notes.txt"), "user edits must remain intact\n");
    let report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /scope|admitted/i);
    assert.equal(await readFile(join(fixture.root, "notes.txt"), "utf8"), "user edits must remain intact\n");
    await rm(join(fixture.root, "notes.txt"));
    await run("git", ["add", "src/auth/session.js"], { cwd: fixture.root });
    report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /staged|index/i);
    assert.equal((await run("git", ["diff", "--cached", "--name-only"], { cwd: fixture.root })).stdout.trim(),
      "src/auth/session.js");
  } finally { await removeFixture(fixture); }
});

test("admitted untracked historical and current bytes survive exact worktree restoration", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "src/auth/user-note.txt"), "historical dirty user file\n");
    const result = await finishTask(fixture, true, true);
    await writeFile(join(fixture.root, "src/auth/user-note.txt"), "current dirty user file\n");
    const before = await observeWorkspace(fixture.root);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.verdict, "baseline_failed_candidate_passed", report.reason);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal(await readFile(join(fixture.root, "src/auth/user-note.txt"), "utf8"), "current dirty user file\n");
  } finally { await removeFixture(fixture); }
});

test("passing baseline is non-discriminating, malformed tests are inconclusive", async () => {
  for (const malformed of [false, true]) {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.root, "src/auth/session.js"), malformed ? BUGGY_SESSION : FIXED_SESSION);
      if (malformed) await writeFile(join(fixture.root, "test/session.test.js"), "this is not JavaScript !\n");
      await run("git", ["add", "."], { cwd: fixture.root });
      await run("git", ["commit", "-q", "-m", "comparison precondition"], { cwd: fixture.root });
      const result = await finishTask(fixture);
      const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
      assert.equal(report.status, "observed", report.reason);
      assert.equal(report.verdict, malformed ? "inconclusive" : "non_discriminating");
      if (malformed) assert.match(report.reason ?? "", /malformed|assertion|test/i);
    } finally { await removeFixture(fixture); }
  }
});

test("comparison requires explicit confirmation", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    await assert.rejects(compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: false }), /confirm/i);
  } finally { await removeFixture(fixture); }
});

test("source code printing fake TAP cannot turn an empty suite into comparison success", async () => {
  const fixture = await makeFixture();
  try {
    const fake = [
      'console.log("TAP version 13\\n# Subtest: forged\\nok 1 - forged\\n1..1\\n# tests 1\\n# suites 0\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0");',
      "",
    ].join("\n");
    await writeFile(join(fixture.root, "test/session.test.js"), fake);
    await run("git", ["add", "."], { cwd: fixture.root });
    await run("git", ["commit", "-q", "-m", "empty suite with fake output"], { cwd: fixture.root });
    const result = await finishTask(fixture);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.verdict, "inconclusive");
    assert.ok(report.variants.every((variant) => variant.checks.every((check) => !check.validTests)));
  } finally { await removeFixture(fixture); }
});

test("full index equivalence remains checked when an admitted tracked file is deleted", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "src/auth/obsolete.js"), "// obsolete implementation\n");
    await run("git", ["add", "."], { cwd: fixture.root });
    await run("git", ["commit", "-q", "-m", "tracked deletion fixture"], { cwd: fixture.root });
    const result = await finishTask(fixture, true, true);
    await rm(join(fixture.root, "src/auth/obsolete.js"));
    const index = (await run("git", ["ls-files", "-s", "-z"], { cwd: fixture.root })).stdout;
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.verdict, "baseline_failed_candidate_passed", report.reason);
    assert.ok(report.variants.every((variant) => variant.indexHash === variant.restoredIndexHash));
    assert.equal((await run("git", ["ls-files", "-s", "-z"], { cwd: fixture.root })).stdout, index);
  } finally { await removeFixture(fixture); }
});

test("candidate regressions never become fail/pass verdicts", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    await writeFile(join(fixture.root, "src/auth/session.js"), BUGGY_SESSION);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.verdict, "candidate_failed", report.reason);
    assert.equal(report.evidenceLevel, null);
  } finally { await removeFixture(fixture); }
});

test("caller cancellation kills the active verifier, cleans worktrees and stops only its maintenance task", async (t) => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, "test/session.test.js"), SESSION_TEST + [
      'test("comparison cancellation wait", async () => {',
      '  if (process.cwd().includes("keystone-isolated-")) await new Promise(resolve => setTimeout(resolve, 15000));',
      "});",
      "",
    ].join("\n"));
    await run("git", ["add", "."], { cwd: fixture.root });
    await run("git", ["commit", "-q", "-m", "cancellable comparison fixture"], { cwd: fixture.root });
    const result = await finishTask(fixture);
    const ledger = await readFile(fixture.paths.ledgerFile(result.taskId), "utf8");
    const before = await observeWorkspace(fixture.root);
    const worktrees = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
    const controller = new AbortController();
    const authorize = KernelSession.prototype.authorizeOperation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    t.mock.method(KernelSession.prototype, "authorizeOperation", async function (
      this: KernelSession, input: Parameters<KernelSession["authorizeOperation"]>[0],
    ) {
      const result = await authorize.call(this, input);
      if (input.capability === "cmd.exec") timer = setTimeout(() => controller.abort(), 150);
      return result;
    });
    const start = Date.now();
    let report;
    try {
      report = await compareBaselineCandidate(fixture.paths, result.taskId, {
        confirmed: true, signal: controller.signal,
      });
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /cancel|abort/i);
    assert.equal(report.verdict, "inconclusive");
    assert.ok(Date.now() - start < 10_000, "cancelled command must not wait for its 15 second timer");
    const maintenance = await KernelSession.open({ paths: fixture.paths, taskId: report.comparisonTaskId! });
    assert.equal(maintenance.state().status, "stopped");
    assert.deepEqual(await maintenance.evidence(), []);
    assert.equal(maintenance.state().activeLeaseIds.length, 0);
    assert.equal(maintenance.events().filter((event) => event.type === "lease.issued" &&
      event.payload.capability === "cmd.exec").length, 1);
    assert.equal(await readFile(fixture.paths.ledgerFile(result.taskId), "utf8"), ledger);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout, worktrees);
    const preCancelled = await compareBaselineCandidate(fixture.paths, result.taskId, {
      confirmed: true, signal: AbortSignal.abort(),
    });
    assert.equal(preCancelled.status, "blocked");
    assert.equal(preCancelled.comparisonTaskId, undefined);
    assert.equal(preCancelled.variants.length, 0);
  } finally { await removeFixture(fixture); }
});

test("source changes at command admission block comparison without reverting user edits", async (t) => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    const beforeLedger = await readFile(fixture.paths.ledgerFile(result.taskId), "utf8");
    const authorize = KernelSession.prototype.authorizeOperation;
    t.mock.method(KernelSession.prototype, "authorizeOperation", async function (
      this: KernelSession, input: Parameters<KernelSession["authorizeOperation"]>[0],
    ) {
      const grant = await authorize.call(this, input);
      if (input.capability === "cmd.exec") {
        await writeFile(join(fixture.root, "src/auth/session.js"), FIXED_SESSION + "// concurrent user edit\n");
      }
      return grant;
    });
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /source.*changed/i);
    const maintenance = await KernelSession.open({ paths: fixture.paths, taskId: report.comparisonTaskId! });
    assert.equal(maintenance.events().filter((event) => event.type === "action.executed" &&
      event.payload.outputBytes !== undefined).length, 0, "changed source must prevent verifier launch");
    assert.equal(maintenance.state().status, "stopped");
    assert.equal(await readFile(fixture.paths.ledgerFile(result.taskId), "utf8"), beforeLedger);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), FIXED_SESSION + "// concurrent user edit\n");
  } finally { await removeFixture(fixture); }
});

test("a verifier mutating its isolated implementation invalidates its captured pass", async () => {
  const fixture = await makeFixture();
  try {
    const result = await finishTask(fixture);
    await writeFile(join(fixture.root, "src/auth/session.js"), FIXED_SESSION + [
      'require("node:fs").appendFileSync(__filename, "// mutated by test execution\\n");',
      "",
    ].join("\n"));
    const before = await observeWorkspace(fixture.root);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.equal(report.verdict, "inconclusive");
    assert.match(report.reason ?? "", /mutated/i);
    assert.equal(report.variants.at(-1)?.unchangedAfterExecution, false);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal((await KernelSession.open({ paths: fixture.paths, taskId: report.comparisonTaskId! })).state().status, "stopped");
  } finally { await removeFixture(fixture); }
});

test("ignored user documentation is not copied, deleted or modified to make comparison pass", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(join(fixture.root, ".gitignore"), "docs/\n");
    await run("git", ["add", "."], { cwd: fixture.root });
    await run("git", ["commit", "-q", "-m", "ignored user documentation"], { cwd: fixture.root });
    const result = await finishTask(fixture);
    await mkdir(join(fixture.root, "docs"));
    await writeFile(join(fixture.root, "docs/user-notes.md"), "private local notes\n");
    const before = await observeWorkspace(fixture.root);
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /ignored/i);
    assert.equal((await observeWorkspace(fixture.root)).fingerprint, before.fingerprint);
    assert.equal(await readFile(join(fixture.root, "docs/user-notes.md"), "utf8"), "private local notes\n");
  } finally { await removeFixture(fixture); }
});

test("absolute Git hook paths in linked source worktrees are rejected before creating comparison worktrees", async () => {
  const fixture = await makeFixture();
  let linked: string | undefined;
  try {
    linked = await createIsolatedWorkspace(fixture.root, "HEAD", false);
    const result = await finishTask({ ...fixture, root: linked });
    await writeFile(join(fixture.root, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const before = (await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout;
    const report = await compareBaselineCandidate(fixture.paths, result.taskId, { confirmed: true });
    assert.equal(report.status, "blocked");
    assert.match(report.reason ?? "", /hook/i);
    assert.equal(report.comparisonTaskId, undefined);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd: fixture.root })).stdout, before);
  } finally {
    if (linked) await removeIsolatedWorkspace(fixture.root, linked);
    await removeFixture(fixture);
  }
});
