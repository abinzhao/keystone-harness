/**
 * Workbench API: the endpoints the four-zone surface needs beyond the task
 * detail and proof it already had (PRD UI-01..UI-05, OT-03, DP-02, ST-02).
 *
 * Every test drives the real server against a real Git repository, because the
 * two things most likely to be wrong here are exactly the things a mock would
 * hide: whether the diff comes from the repository the task actually changed,
 * and whether a revision can fork the ledger.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ExperienceFirewall, KernelSession } from "@keystone/kernel";
import type { ModelAdapter } from "@keystone/models";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { startServer } from "../src/index.ts";
import {
  FIXED_SESSION,
  FINISH_ACTION,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

interface GatedModel {
  readonly adapter: ModelAdapter;
  /** Resolves once the model has been called at least `index` times. */
  waitForCall(index: number): Promise<void>;
  /** Let the second call proceed; the first two calls gate the run in-flight. */
  release(): void;
}

/**
 * A scripted model whose second call blocks until released.
 *
 * Pause, stop and revision are only legal while a task is *working*, and a
 * scripted run finishes in milliseconds. Blocking inside the model call is what
 * makes "the user acts while the task is running" a deterministic test rather
 * than a race.
 */
function gatedModel(responses: readonly string[]): GatedModel {
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiters: { index: number; resolve: () => void }[] = [];

  const adapter: ModelAdapter = {
    descriptor: scriptedModelDescriptor({ id: "builder" }),
    async complete() {
      calls += 1;
      for (const waiter of [...waiters]) {
        if (calls >= waiter.index) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      if (calls >= 2) await gate;
      return {
        text: responses[Math.min(calls - 1, responses.length - 1)] ?? "",
        toolCalls: [],
        usage: { inputTokens: 17, outputTokens: 5 },
        modelName: "scripted-1",
        finishReason: "stop" as const,
      };
    },
  };

  return {
    adapter,
    waitForCall(index: number): Promise<void> {
      if (calls >= index) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ index, resolve });
      });
    },
    release: () => release(),
  };
}

async function waitForRun(
  base: string,
  token: string,
  taskId: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${base}/v1/tasks/${taskId}/run`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (body["status"] !== "running") return body;
    if (Date.now() > deadline) throw new Error("the run did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const START_BODY = (root: string) => ({
  workspacePath: root,
  request: "Fix the duplicate session refresh in src/auth/session.js.",
  references: [{ kind: "directory", value: "src" }],
  writePaths: ["src/**"],
  allowedCommands: ["node", "npm"],
  acceptContract: true,
});

test("the diff endpoint reports the change the task actually made, from the repository", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    models: [
      createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ],
      }),
    ],
    token: "workbench-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}` };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(START_BODY(fixture.root)),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };
    const run = await waitForRun(base, server.token, taskId);
    assert.equal(run["taskStatus"], "proven", JSON.stringify(run["reasons"]));

    const diff = (await (
      await fetch(`${base}/v1/tasks/${taskId}/diff`, { headers: auth })
    ).json()) as {
      available: boolean;
      scope: string;
      rootPath: string;
      changedPaths: readonly string[];
      unifiedDiff: string;
    };
    assert.equal(diff.available, true);
    assert.equal(diff.scope, "task_paths");
    assert.deepEqual(diff.changedPaths, ["src/auth/session.js"]);
    assert.match(diff.unifiedDiff, /diff --git/);
    assert.match(diff.unifiedDiff, /refreshSession/);
    // The removed line is what makes this a diff rather than a file dump.
    assert.match(diff.unifiedDiff, /^-.*refreshes \+= 1;/m);

    const checkpoints = (await (
      await fetch(`${base}/v1/tasks/${taskId}/checkpoints`, { headers: auth })
    ).json()) as { checkpoints: readonly { seq: number; reason: string; parentCheckpointId: string | null }[] };
    assert.ok(checkpoints.checkpoints.length >= 2, JSON.stringify(checkpoints));
    const seqs = checkpoints.checkpoints.map((entry) => entry.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "checkpoints must be ordered by seq");
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("a revision sent while the task is working is applied by the run and creates a new version", async () => {
  const fixture = await makeFixture();
  const model = gatedModel([
    envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
    envelopeFor([FINISH_ACTION]),
  ]);
  const server = await startServer({
    paths: fixture.paths,
    models: [model.adapter],
    token: "workbench-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(START_BODY(fixture.root)),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };

    // The run is now blocked inside its second model call: still "executing".
    await model.waitForCall(2);
    const revision = await fetch(`${base}/v1/tasks/${taskId}/contract`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        goal: "Refresh the session exactly once per expiry.",
        writePaths: ["src/**"],
        reason: "clarify the target result",
      }),
    });
    assert.equal(revision.status, 202, await revision.clone().text());
    assert.equal(((await revision.json()) as { queued: boolean }).queued, true);

    model.release();
    const run = await waitForRun(base, server.token, taskId);
    assert.equal(run["status"], "finished", JSON.stringify(run));

    const detail = (await (await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth })).json()) as {
      status: string;
      contract: { version: number; goal: string };
    };
    assert.equal(detail.contract.version, 2, JSON.stringify(detail.contract));
    assert.equal(detail.contract.goal, "Refresh the session exactly once per expiry.");

    const events = (await (
      await fetch(`${base}/v1/tasks/${taskId}/events?since=0`, { headers: auth })
    ).json()) as { events: readonly { type: string; payload: Record<string, unknown> }[] };
    const revised = events.events.find((event) => event.type === "contract.revised");
    assert.ok(revised !== undefined, "the revision must be on the record");
    assert.ok(
      (revised.payload["changedFields"] as readonly string[]).includes("goal"),
      JSON.stringify(revised.payload["changedFields"]),
    );
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("pause and stop sent while the task is working end the run with that status", async () => {
  for (const [kind, expected] of [
    ["pause", "paused"],
    ["stop", "stopped"],
  ] as const) {
    const fixture = await makeFixture();
    const model = gatedModel([
      envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
      envelopeFor([writeAction("src/late.js", "export const late = true;")]),
    ]);
    const server = await startServer({
      paths: fixture.paths,
      models: [model.adapter],
      token: "workbench-token-0123456789",
    });
    const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

    try {
      const base = `http://127.0.0.1:${server.port}`;
      const accepted = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(START_BODY(fixture.root)),
      });
      const { taskId } = (await accepted.json()) as { taskId: string };

      await model.waitForCall(2);
      const control = await fetch(`${base}/v1/tasks/${taskId}/control`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ kind, reason: `test ${kind}` }),
      });
      assert.equal(control.status, 202, await control.text());

      model.release();
      await waitForRun(base, server.token, taskId);

      const detail = (await (await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth })).json()) as {
        status: string;
        budgetUsed: { tokens: number; wallClockMs: number };
      };
      assert.equal(detail.status, expected, JSON.stringify(detail));
      const { access } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await assert.rejects(() => access(join(fixture.root, "src/late.js")));
      assert.equal(detail.budgetUsed.tokens, 44, "actual usage includes the response discarded after stop");
      assert.ok(detail.budgetUsed.wallClockMs > 0);
      const events = (await (await fetch(`${base}/v1/tasks/${taskId}/events`, { headers: auth })).json()) as {
        events: { type: string; payload: Record<string, unknown> }[];
      };
      assert.equal(events.events.filter((event) => event.type === "action.executed").length, 1,
        "the stopped response cannot execute another tool");
    } finally {
      await server.close();
      await removeFixture(fixture);
    }
  }
});

test("a revision is refused when no run is in flight, because the kernel only permits it while working", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    models: [
      createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ],
      }),
    ],
    token: "workbench-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(START_BODY(fixture.root)),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };
    await waitForRun(base, server.token, taskId);

    const response = await fetch(`${base}/v1/tasks/${taskId}/contract`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ goal: "something else" }),
    });
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /still working/);

    // The same request body with nothing to change is a client error, not a 409.
    const empty = await fetch(`${base}/v1/tasks/${taskId}/contract`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ reason: "no-op" }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("answering an intervention over HTTP records a user decision and resumes the run", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    models: [
      createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [
          // The model asks instead of acting, which raises a real intervention.
          JSON.stringify({
            summary: "ambiguous",
            actions: [],
            needs_user: {
              question: "Which module owns session refresh?",
              why: "two modules could own it",
              options: ["src/auth", "src/session"],
            },
          }),
          envelopeFor([FINISH_ACTION]),
        ],
      }),
    ],
    token: "workbench-token-0123456789",
    // Long enough that the test answers before the runtime gives up waiting, and
    // short enough that the timer does not hold the test process open.
    interventionTimeoutMs: 8_000,
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(START_BODY(fixture.root)),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };

    // Wait until the question is actually open, rather than guessing a delay.
    let interventionId = "";
    const deadline = Date.now() + 20_000;
    for (;;) {
      const run = (await (
        await fetch(`${base}/v1/tasks/${taskId}/run`, { headers: auth })
      ).json()) as { pendingInterventions?: readonly { interventionId: string }[] };
      const open = run.pendingInterventions ?? [];
      if (open.length > 0) {
        interventionId = open[0]?.interventionId ?? "";
        break;
      }
      if (Date.now() > deadline) throw new Error("no intervention was raised in time");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(interventionId, /^intr_/);

    // The task list must show it too: this is how a user finds a task that is
    // waiting on them (PRD HI-01).
    const list = (await (await fetch(`${base}/v1/tasks`, { headers: auth })).json()) as {
      tasks: readonly { taskId: string; pendingInterventions: number }[];
    };
    assert.equal(list.tasks.find((entry) => entry.taskId === taskId)?.pendingInterventions, 1);

    const decided = await fetch(`${base}/v1/tasks/${taskId}/decisions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ interventionId, decision: "allow", rationale: "own it in src/auth" }),
    });
    assert.equal(decided.status, 200, await decided.clone().text());
    assert.equal(((await decided.json()) as { recorded: boolean }).recorded, true);

    // The same question cannot be answered twice.
    const again = await fetch(`${base}/v1/tasks/${taskId}/decisions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ interventionId, decision: "deny", rationale: "changed my mind" }),
    });
    assert.equal(again.status, 409, await again.clone().text());

    // A decision without a reason is refused with a usable message, not a 500.
    const noReason = await fetch(`${base}/v1/tasks/${taskId}/decisions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ interventionId, decision: "deny" }),
    });
    assert.equal(noReason.status, 400, await noReason.clone().text());

    const run = await waitForRun(base, server.token, taskId);
    assert.equal(run["status"], "finished", JSON.stringify(run));

    const events = (await (
      await fetch(`${base}/v1/tasks/${taskId}/events?since=0`, { headers: auth })
    ).json()) as { events: readonly { type: string; payload: Record<string, unknown> }[] };
    const decision = events.events.find((event) => event.type === "intervention.decided");
    assert.ok(decision !== undefined, "the decision must be on the record");
    // The schema fixes this to a literal: a model or client cannot fabricate it.
    assert.equal(decision.payload["recordedBy"], "user");
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("data management lists what is stored, clears an experience cache, and deletes a task history", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    models: [
      createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [
          envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
          envelopeFor([FINISH_ACTION]),
        ],
      }),
    ],
    token: "workbench-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(START_BODY(fixture.root)),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };
    await waitForRun(base, server.token, taskId);

    const inventoryResponse = await fetch(`${base}/v1/data`, { headers: auth });
    const inventoryText = await inventoryResponse.text();
    assert.equal(inventoryResponse.status, 200, inventoryText);
    const inventory = JSON.parse(inventoryText) as {
      projects: readonly {
        projectId: string;
        name: string | null;
        facts: number;
        experience: { candidates: number; entries: number; evaluations: number };
        bytes: number;
      }[];
      tasks: readonly { taskId: string; status: string; events: number }[];
    };
    const project = inventory.projects.find((entry) => entry.name === "fixture-app");
    assert.ok(project !== undefined, JSON.stringify(inventory.projects));
    assert.ok(project.facts > 0, "the inventory must count project facts");
    assert.ok(project.experience.entries > 0, "a proven run promotes experience");
    const task = inventory.tasks.find((entry) => entry.taskId === taskId);
    assert.equal(task?.status, "proven");
    assert.ok((task?.events ?? 0) > 0);

    const clearResponse = await fetch(`${base}/v1/projects/${project.projectId}/experience/clear`, {
      method: "POST",
      headers: auth,
    });
    const clearText = await clearResponse.text();
    assert.equal(clearResponse.status, 200, clearText);
    const cleared = JSON.parse(clearText) as {
      cleared: { projectId: string; candidates: number; entries: number; evaluations: number };
    };
    assert.deepEqual(cleared.cleared, { projectId: project.projectId, ...project.experience });
    const afterClear = (await (await fetch(`${base}/v1/data`, { headers: auth })).json()) as {
      projects: readonly { projectId: string; experience: { entries: number } }[];
    };
    assert.equal(
      afterClear.projects.find((entry) => entry.projectId === project.projectId)?.experience.entries,
      0,
    );
    await KernelSession.rebuildProjectExperience({ paths: fixture.paths, projectId: project.projectId });
    const firewall = new ExperienceFirewall(fixture.paths, project.projectId);
    await firewall.load();
    assert.deepEqual(firewall.selectForContext({ taskShape: "bugfix", paths: ["src/auth"] }), []);
    assert.ok(firewall.candidates().every((candidate) => candidate.status !== "quarantined"));

    // An id that is not a task id never reaches the filesystem.
    const badId = await fetch(`${base}/v1/tasks/not-a-task-id`, { method: "DELETE", headers: auth });
    assert.equal(badId.status, 400);

    const deleted = (await (
      await fetch(`${base}/v1/tasks/${taskId}`, { method: "DELETE", headers: auth })
    ).json()) as { removed: { events: number; checkpoints: number } };
    assert.ok(deleted.removed.events > 0);
    assert.ok(deleted.removed.checkpoints > 0);

    const list = (await (await fetch(`${base}/v1/tasks`, { headers: auth })).json()) as {
      tasks: readonly { taskId: string }[];
    };
    assert.ok(!list.tasks.some((entry) => entry.taskId === taskId), "the task must be gone");

    const missing = await fetch(`${base}/v1/tasks/${taskId}`, { method: "DELETE", headers: auth });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
