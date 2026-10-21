import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { KernelSession, ProjectFactStore } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor, type ModelAdapter } from "@keystone/models";
import { detectProjectProfile, scanProjectCognition, scanWorkspace } from "@keystone/pack-engineering";
import { contentHash, contextPlanSchema, type ContextPlan, type ProjectFact, type ProjectId } from "@keystone/schemas";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { forkContinuousBranch } from "../src/continuous-branches.ts";
import { removeIsolatedWorkspace } from "../src/isolation.ts";
import {
  autonomyFor, envelopeFor, FIXED_SESSION, FINISH_ACTION, makeFixture,
  removeFixture, run, writeAction, type Fixture,
} from "./fixture.ts";

const ROOT_RULE = "Keep session refresh deterministic.";
const FROZEN_RULE = "User constraint: preserve the session public interface.";
const UPDATED_SESSION = FIXED_SESSION
  .replace("function refreshSession()", "function refreshOnce()")
  .replace("module.exports = { refreshSession };", "module.exports = { refreshSession: refreshOnce };");
const READ_ACTION = {
  intent: "read", tool: "fs.read_file", parameters: { path: "src/auth/session.js" },
  rationale: "inspect the session before changing it", expected_effects: [],
  requested_capabilities: ["fs.read"], produces_evidence_for: [], reversibility: "reversible",
};

interface BuilderObservation {
  readonly plan: ContextPlan;
  readonly prompt: string;
  readonly expectedFacts: readonly ProjectFact[];
  readonly primaryCognition: readonly string[];
}

async function prepareFixture(): Promise<Fixture> {
  const fixture = await makeFixture();
  await writeFile(join(fixture.root, "AGENTS.md"), ROOT_RULE);
  await writeFile(join(fixture.root, "src/auth/AGENTS.md"), "Preserve session interfaces.");
  await writeFile(join(fixture.root, "src/auth/label.ts"), [
    'import { refreshSession } from "./session.js";',
    "export function sessionLabel(): string { return String(refreshSession()); }",
    "",
  ].join("\n"));
  await run("git", ["add", "."], { cwd: fixture.root });
  await run("git", ["commit", "-q", "-m", "cognition fixture"], { cwd: fixture.root });
  return fixture;
}

async function primaryCognition(fixture: Fixture, projectId: ProjectId): Promise<readonly string[]> {
  return Promise.all([
    fixture.paths.factsFile(projectId),
    join(fixture.paths.projectDir(projectId), "cognition.json"),
    join(fixture.paths.projectDir(projectId), "cognition-cache.json"),
    join(fixture.paths.projectDir(projectId), "cognition.events.jsonl"),
  ].map((path) => readFile(path, "utf8")));
}

function observedBuilder(fixture: Fixture, observations: BuilderObservation[],
  target: () => { taskId: string; workPath: string; branchId?: string }): ModelAdapter {
  const adapter = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "builder" }),
    responses: [
      envelopeFor([READ_ACTION]),
      envelopeFor([writeAction("src/auth/session.js", UPDATED_SESSION)]),
      envelopeFor([FINISH_ACTION]),
    ],
  });
  return {
    descriptor: adapter.descriptor,
    async complete(request) {
      const { taskId, workPath, branchId } = target();
      const session = await KernelSession.open({
        paths: fixture.paths, taskId: taskId as never, branchId: branchId as never,
      });
      const event = session.events().filter((entry) => entry.type === "context.plan_created").at(-1);
      assert.ok(event);
      const plan = contextPlanSchema.parse(event.payload);
      const snapshot = await scanWorkspace(workPath);
      const profile = await detectProjectProfile(workPath, session.projectId);
      const expected = await scanProjectCognition({
        rootPath: workPath, profile, snapshot: { ...snapshot, projectId: session.projectId },
      });
      const content = request.messages[0]?.content;
      assert.equal(typeof content, "string");
      observations.push({
        plan, prompt: content as string, expectedFacts: expected.facts,
        primaryCognition: await primaryCognition(fixture, session.projectId),
      });
      return adapter.complete(request);
    },
  };
}

async function freezeConstraint(runtime: KeystoneRuntime, fixture: Fixture, corrected = true): Promise<ProjectFact> {
  const project = await runtime.attachProject(fixture.root);
  const rule = project.facts.all().find((fact) =>
    fact.kind === "rule" && fact.source.locator === "src/auth/AGENTS.md");
  assert.ok(rule);
  return KernelSession.editProjectFact({
    paths: fixture.paths, projectId: project.projectId, factId: rule.factId,
    expectedHash: contentHash(rule), statement: corrected ? FROZEN_RULE : undefined, frozen: true,
  });
}

function assertBuilderContext(observations: readonly BuilderObservation[], frozen: ProjectFact): void {
  assert.equal(observations.length, 3, "first, unchanged and changed workspace plans must reach the Builder");
  for (const [index, { plan, prompt, expectedFacts }] of observations.entries()) {
    const rule = expectedFacts.find((fact) => fact.kind === "rule" && fact.source.locator === "AGENTS.md");
    assert.ok(rule);
    assert.ok(plan.factsUsed.includes(rule.factId), `Builder plan ${index + 1} must admit the current AGENTS rule`);
    assert.match(prompt, /## Project rule:/, "rules must be mandatory facts, not optional file excerpts");
    assert.ok(prompt.includes(ROOT_RULE));
    const snapshotId = plan.items.find((item) => item.kind === "contract")?.applicableSnapshot;
    assert.ok(snapshotId);
    for (const fact of expectedFacts.filter((entry) => entry.factId !== frozen.factId)) {
      assert.ok(plan.factsUsed.includes(fact.factId), `Builder plan ${index + 1} omitted ${fact.kind}: ${fact.statement}`);
      const item = plan.items.find((entry) => entry.kind === "fact" && entry.ref === fact.factId);
      assert.ok(item);
      assert.equal(item.applicableSnapshot, snapshotId);
      assert.equal(item.source.applicableSnapshot, snapshotId);
      assert.equal(item.source.observedAt, plan.items.find((entry) => entry.kind === "contract")?.source.observedAt);
      assert.equal(item.source.trustLevel, "observed");
      assert.ok(prompt.includes(JSON.stringify(fact.statement)));
    }
    assert.ok(expectedFacts.some((fact) => fact.kind === "module" && fact.source.locator.endsWith(".ts")));
    assert.ok(expectedFacts.some((fact) => fact.kind === "module" && fact.source.locator.endsWith(".js")));
    assert.ok(expectedFacts.some((fact) => fact.kind === "dependency"));
    assert.ok(expectedFacts.some((fact) => fact.kind === "test_mapping"));
    assert.ok(plan.factsUsed.includes(frozen.factId), "frozen user constraints must survive later repository snapshots");
    const constraint = plan.items.find((item) => item.ref === frozen.factId);
    assert.ok(constraint);
    assert.equal(plan.factsUsed.filter((id) => id === frozen.factId).length, 1);
    assert.equal(constraint.source.sourceKind, frozen.source.sourceKind);
    assert.equal(constraint.source.trustLevel, frozen.source.trustLevel);
    assert.equal(constraint.source.applicableSnapshot, undefined, "frozen constraints are not newly observed repository facts");
    assert.deepEqual(constraint.source.derivedFrom, frozen.source.derivedFrom);
    assert.deepEqual(constraint.source.invalidatedBy, frozen.source.invalidatedBy);
    assert.ok(prompt.includes(JSON.stringify(frozen.statement)));
    assert.ok(plan.tokensUsed <= plan.tokenBudget);
    assert.ok(!plan.exclusions.some((entry) => /different snapshot/.test(entry.reason) &&
      expectedFacts.some((fact) => fact.factId === entry.ref)));
  }
  const snapshots = observations.map(({ plan }) => plan.items.find((item) => item.kind === "contract")?.applicableSnapshot);
  assert.equal(new Set(snapshots).size, 3, "even unchanged workspaces receive fresh observation identities");
  assert.ok(!observations[0]!.prompt.includes("function refreshOnce at"));
  assert.ok(observations[2]!.prompt.includes("function refreshOnce at"), "post-write symbols must be refreshed");
  assert.ok(!observations[2]!.prompt.includes("function refreshSession at"), "old symbols must not survive the write");
}

function assertCheckpointContext(session: KernelSession, observations: readonly BuilderObservation[]): void {
  const events = session.events();
  const first = observations[0]!.plan;
  const firstIndex = events.findIndex((event) => event.type === "context.plan_created" && event.payload.planId === first.planId);
  const afterRead = events.slice(firstIndex + 1).find((event) => event.type === "checkpoint.created");
  assert.equal(afterRead?.payload.workspaceSnapshotId,
    first.items.find((item) => item.kind === "contract")?.applicableSnapshot);
  const last = observations.at(-1)!.plan;
  const lastIndex = events.findIndex((event) => event.type === "context.plan_created" && event.payload.planId === last.planId);
  const afterFinish = events.slice(lastIndex + 1).filter((event) => event.type === "checkpoint.created");
  assert.ok(afterFinish.length > 0);
  for (const event of afterFinish) {
    assert.equal(event.payload.workspaceSnapshotId,
      last.items.find((item) => item.kind === "contract")?.applicableSnapshot);
  }
}

test("current indexed cognition and mandatory rules reach first and subsequent Builder contexts", async () => {
  const fixture = await prepareFixture();
  try {
    const observations: BuilderObservation[] = [];
    let taskId = "";
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths, models: [observedBuilder(fixture, observations, () => ({ taskId, workPath: fixture.root }))],
    });
    const frozen = await freezeConstraint(runtime, fixture);
    const result = await runtime.runTask({
      workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "directory", value: "src" }, { kind: "directory", value: "test" }],
      autonomy: autonomyFor(["src/**", "test/**"]), acceptContractAutomatically: true,
      onTaskCreated: (id) => { taskId = id; },
    });
    assert.equal(result.status, "proven");
    assertBuilderContext(observations, frozen);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    assertCheckpointContext(session, observations);
    const facts = new ProjectFactStore(fixture.paths, session.projectId);
    await facts.load();
    assert.deepEqual(facts.byId(frozen.factId), frozen, "context admission must not rewrite the frozen source");
  } finally { await removeFixture(fixture); }
});

test("historical fork Builder contexts use branch observations without writing primary cognition", async () => {
  const fixture = await prepareFixture();
  let workPath: string | undefined;
  try {
    const parent = await KeystoneRuntime.create({
      paths: fixture.paths, models: [createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [envelopeFor([writeAction("src/auth/session.js", UPDATED_SESSION)]), envelopeFor([FINISH_ACTION])],
      })],
    });
    const frozen = await freezeConstraint(parent, fixture);
    const result = await parent.runTask({
      workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "directory", value: "src" }, { kind: "directory", value: "test" }],
      autonomy: autonomyFor(["src/**", "test/**"]), acceptContractAutomatically: true,
    });
    assert.equal(result.status, "proven");
    const original = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId });
    const checkpoint = original.events().find((event) => event.type === "checkpoint.created");
    assert.ok(checkpoint);
    const branch = await forkContinuousBranch(fixture.paths, result.taskId, {
      checkpointId: String(checkpoint.payload.checkpointId), label: "cognition-history",
    });
    workPath = branch.workspacePath;
    assert.ok(workPath);
    assert.ok(!(await readFile(join(workPath, "src/auth/session.js"), "utf8")).includes("refreshOnce"));
    const observations: BuilderObservation[] = [];
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths, models: [observedBuilder(fixture, observations, () => ({
        taskId: result.taskId, workPath: workPath!, branchId: branch.branchId,
      }))],
    });
    const resumed = await runtime.resumeTask(result.taskId, {}, branch.branchId);
    assert.equal(resumed.status, "proven");
    assertBuilderContext(observations, frozen);
    const session = await KernelSession.open({ paths: fixture.paths, taskId: result.taskId, branchId: branch.branchId });
    assertCheckpointContext(session, observations);
    for (const observation of observations) {
      assert.equal(observation.plan.branchId, branch.branchId);
      assert.deepEqual(observation.primaryCognition, observations[0]!.primaryCognition);
    }
    assert.deepEqual(await primaryCognition(fixture, session.projectId), observations[0]!.primaryCognition);
    assert.equal(await readFile(join(fixture.root, "src/auth/session.js"), "utf8"), UPDATED_SESSION);
    assert.deepEqual(session.contract()?.autonomy, original.contract()?.autonomy);
  } finally {
    if (workPath) await removeIsolatedWorkspace(fixture.root, workPath);
    await removeFixture(fixture);
  }
});

test("freezing a repository rule without editing preserves it across Builder observations", async () => {
  const fixture = await prepareFixture();
  try {
    const observations: BuilderObservation[] = [];
    let taskId = "";
    const runtime = await KeystoneRuntime.create({
      paths: fixture.paths, models: [observedBuilder(fixture, observations, () => ({ taskId, workPath: fixture.root }))],
    });
    const frozen = await freezeConstraint(runtime, fixture, false);
    assert.equal(frozen.source.sourceKind, "repository");
    const result = await runtime.runTask({
      workspacePath: fixture.root, request: "fix src/auth/session.js",
      references: [{ kind: "directory", value: "src" }, { kind: "directory", value: "test" }],
      autonomy: autonomyFor(["src/**", "test/**"]), acceptContractAutomatically: true,
      onTaskCreated: (id) => { taskId = id; },
    });
    assert.equal(result.status, "proven");
    assertBuilderContext(observations, frozen);
    const facts = new ProjectFactStore(fixture.paths, result.contract.projectId);
    await facts.load();
    assert.deepEqual(facts.byId(frozen.factId), frozen);
  } finally { await removeFixture(fixture); }
});
