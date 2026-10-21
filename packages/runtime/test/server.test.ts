/**
 * The local Run Protocol server (PRD 1.4, ST-03).
 *
 * This is the boundary a desktop shell, an editor or CI talks to, so the tests
 * are written the way a client would behave: real HTTP requests against a real
 * server holding a real ledger, with the token handling included. The two things
 * most worth protecting are that an unauthenticated caller cannot start a task,
 * and that the proof a remote client sees is the same one produced locally.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { startServer } from "../src/index.ts";
import { FINISH_ACTION, FIXED_SESSION, autonomyFor, envelopeFor, makeFixture, removeFixture, writeAction } from "./fixture.ts";

test("workbench assets are confined, MIME typed and protected by nonce CSP", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(base);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const module = await fetch(`${base}/assets/client/main.js`);
    assert.equal(module.status, 200); assert.match(module.headers.get("content-type") ?? "", /text\/javascript/);
    const css = await fetch(`${base}/assets/styles/workbench.css`);
    assert.equal(css.status, 200); assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    for (const path of ["/assets/package.json", "/assets/client/%2e%2e/%2e%2e/src/server.ts", "/assets/client/%2e%2e%2f%2e%2e%2fsrc/server.ts"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
  } finally { await server.close(); await removeFixture(fixture); }
});

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

test("the server refuses unauthenticated callers and serves the protocol with a token", async () => {
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
    token: "test-token-0123456789",
  });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal(server.protocolVersion, "keystone.run.protocol@1.5.0");

    // No token, and a wrong token, are both refused.
    const anonymous = await fetch(`${base}/v1/tasks`);
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`${base}/v1/tasks`, {
      headers: { authorization: "Bearer not-the-token-000000" },
    });
    assert.equal(wrong.status, 401);

    // The workbench page itself needs no token: it is inert without one, and the
    // token arrives in the fragment, which the browser never sends.
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Keystone — task workbench/);

    const capabilities = (await (
      await fetch(`${base}/v1/capabilities`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
    ).json()) as Record<string, unknown>;
    assert.equal(capabilities["protocolVersion"], server.protocolVersion);
    assert.equal(capabilities["mode"], "standard");
    assert.equal((capabilities["taskStatuses"] as readonly string[]).length, 14);

    const unknown = await fetch(`${base}/v1/nonsense`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("contract preview drafts a readable contract, writes nothing, and stays authed", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    token: "test-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // No token -> refused like every other route.
    const anonymous = await fetch(`${base}/v1/contract/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath: fixture.root, request: "fix session refresh" }),
    });
    assert.equal(anonymous.status, 401);

    // Missing fields -> a 400, not a half-created task.
    const bad = await fetch(`${base}/v1/contract/preview`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ workspacePath: fixture.root }),
    });
    assert.equal(bad.status, 400);

    const preview = await fetch(`${base}/v1/contract/preview`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        workspacePath: fixture.root,
        request: "Fix the duplicate session refresh in src/auth/session.js.",
        writePaths: ["src/**"],
        allowedCommands: ["node", "npm"],
      }),
    });
    if (preview.status !== 200) {
      assert.fail(`expected contract preview 200, got ${preview.status}: ${await preview.text()}`);
    }
    const body = (await preview.json()) as {
      contract: { goal: string; completionConditions: readonly { required: boolean }[] };
      writePaths: readonly string[];
      allowedCommands: readonly string[];
      questions: readonly unknown[];
    };
    assert.ok(body.contract.goal.length > 0);
    // The boundary the user confirms is the envelope's authorized write paths.
    assert.ok(body.writePaths.includes("src/**"));
    assert.ok(body.allowedCommands.includes("node"));
    assert.ok(body.contract.completionConditions.length >= 1);

    // The preview must not have created a task: it is a draft for the user to read.
    const tasks = (await (await fetch(`${base}/v1/tasks`, { headers: auth })).json()) as {
      tasks: readonly unknown[];
    };
    assert.equal(tasks.tasks.length, 0);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("a task started over HTTP reaches proven and its proof carries the real change set", async () => {
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
    token: "test-token-0123456789",
  });
  const auth = { authorization: `Bearer ${server.token}` };

  try {
    const base = `http://127.0.0.1:${server.port}`;

    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        workspacePath: fixture.root,
        request: "Fix the duplicate session refresh in src/auth/session.js.",
        references: [{ kind: "directory", value: "src" }],
        writePaths: ["src/**"],
        allowedCommands: ["node", "npm"],
        acceptContract: true,
      }),
    });
    assert.equal(accepted.status, 202);
    const { taskId } = (await accepted.json()) as { taskId: string };
    assert.match(taskId, /^task_/);

    const run = await waitForRun(base, server.token, taskId);
    assert.equal(run["status"], "finished", JSON.stringify(run));
    assert.equal(run["taskStatus"], "proven", JSON.stringify(run["reasons"]));
    assert.deepEqual(run["changedPaths"], ["src/auth/session.js"]);
    // The run reports what it learned, so a client can show it.
    const learning = run["learning"] as { promoted: readonly unknown[]; candidates: readonly unknown[] };
    assert.equal(learning.promoted.length, 1);
    assert.equal(learning.candidates.length, 2);

    const list = (await (
      await fetch(`${base}/v1/tasks`, { headers: auth })
    ).json()) as { tasks: readonly { taskId: string; status: string }[] };
    assert.ok(list.tasks.some((task) => task.taskId === taskId && task.status === "proven"));

    const detail = (await (
      await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth })
    ).json()) as Record<string, unknown>;
    assert.equal(detail["status"], "proven");
    assert.equal((detail["ledger"] as { integrityOk: boolean }).integrityOk, true);
    const contract = detail["contract"] as { completionConditions: readonly { conditionId: string }[] };
    assert.deepEqual(
      contract.completionConditions.map((condition) => condition.conditionId),
      ["cond.target_tests", "cond.scope_check"],
    );
    const evidence = detail["evidence"] as readonly { level: string; status: string }[];
    assert.ok(evidence.length >= 2);
    assert.ok(evidence.every((record) => record.level !== "E0" && record.status === "valid"));

    // The proof must describe the change set, not an empty one: a client on
    // another machine has no working copy to diff.
    const proof = (await (
      await fetch(`${base}/v1/tasks/${taskId}/proof`, { headers: auth })
    ).json()) as Record<string, unknown>;
    assert.equal(proof["outcome"], "proven");
    const changes = proof["changes"] as { changedPaths: readonly string[]; withinScope: boolean };
    assert.deepEqual(changes.changedPaths, ["src/auth/session.js"]);
    assert.equal(changes.withinScope, true);

    const events = (await (
      await fetch(`${base}/v1/tasks/${taskId}/events?since=0`, { headers: auth })
    ).json()) as { events: readonly { seq: number; type: string }[] };
    assert.ok(events.events.length > 10, "the ledger must be readable over the protocol");
    assert.equal(events.events[0]?.type, "task.created");

    const since = events.events[5]?.seq ?? 0;
    const tail = (await (
      await fetch(`${base}/v1/tasks/${taskId}/events?since=${since}`, { headers: auth })
    ).json()) as { events: readonly { seq: number }[] };
    assert.ok(tail.events.every((event) => event.seq > since), "since must be honoured");

    // An intervention that is not waiting cannot be answered: the server refuses
    // rather than recording a decision for a question nobody asked.
    const stray = await fetch(`${base}/v1/tasks/${taskId}/decisions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ interventionId: "intr_01M59N02E9Z2FJ4NV2BHR59Z5H", decision: "allow" }),
    });
    assert.equal(stray.status, 404);

    const badRequest = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ request: "no workspace" }),
    });
    assert.equal(badRequest.status, 400);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("a workspace that is not a Git repository is refused with a reason, not a dead task id", async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    paths: fixture.paths,
    models: [
      createSequenceAdapter({
        descriptor: scriptedModelDescriptor({ id: "builder" }),
        responses: [envelopeFor([FINISH_ACTION])],
      }),
    ],
  });
  // A real directory that is *not* a Git repository. A hardcoded "/tmp" would be
  // wrong on Windows and might even sit inside a repository; an empty temporary
  // directory is exactly the "no repository here" case on every platform.
  const notARepository = await mkdtemp(join(tmpdir(), "keystone-not-a-repo-"));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspacePath: notARepository,
        request: "do something",
        writePaths: ["**"],
        acceptContract: true,
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /could not be created/);
  } finally {
    await server.close();
    await removeFixture(fixture);
    await rm(notARepository, { recursive: true, force: true });
  }
});

test("without write paths the task cannot write, because the envelope stays closed", async () => {
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
    // A workbench may wait ten minutes for a human; a test cannot.
    interventionTimeoutMs: 300,
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };

    const accepted = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        workspacePath: fixture.root,
        request: "Fix the duplicate session refresh in src/auth/session.js.",
        references: [{ kind: "directory", value: "src" }],
        // No writePaths on purpose.
        acceptContract: true,
      }),
    });
    const { taskId } = (await accepted.json()) as { taskId: string };
    const run = await waitForRun(base, server.token, taskId);

    assert.notEqual(run["taskStatus"], "proven");
    assert.deepEqual(run["changedPaths"], []);
    // The refusal must be on the record rather than silently ignored.
    const detail = (await (await fetch(`${base}/v1/tasks/${taskId}/events?since=0`, { headers: auth })).json()) as {
      events: readonly { type: string }[];
    };
    assert.ok(detail.events.some((event) => event.type === "action.rejected"));
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
