import assert from "node:assert/strict";
import test from "node:test";
import { readLedger } from "@keystone/kernel";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { startServer } from "../src/server.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

test("named human option is validated, persisted and returned to the next model step", async () => {
  const fixture = await makeFixture();
  const adapter = createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "decision-test" }),
    responses: [
      JSON.stringify({ summary: "Choose module", actions: [], needs_user: {
        question: "Choose a module", why: "Ambiguous", options: ["src/auth", "src/session"],
      } }),
      JSON.stringify({ summary: "Answer", answer: "Chosen module", actions: [] }),
    ],
  });
  const server = await startServer({ paths: fixture.paths, models: [adapter], token: "option-test", interventionTimeoutMs: 10000 });
  const headers = { authorization: "Bearer option-test", "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${server.url}v1/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const { taskId } = await (await post("tasks", {
      workspacePath: fixture.root, request: "Analyze", taskIntent: "analysis",
    })).json() as { taskId: string };
    let intervention: any;
    for (let i = 0; i < 100; i++) {
      const run = await (await fetch(`${server.url}v1/tasks/${taskId}/run`, { headers })).json() as any;
      intervention = run.pendingInterventions?.[0]; if (intervention) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.ok(intervention);
    const foreign = await post(`tasks/${taskId}/decisions`, {
      interventionId: intervention.interventionId, decision: "modify", optionId: "foreign", rationale: "select",
    });
    assert.equal(foreign.status, 400);
    const option = intervention.options.find((entry: any) => entry.label === "src/session");
    const accepted = await post(`tasks/${taskId}/decisions`, {
      interventionId: intervention.interventionId, decision: "modify", optionId: option.optionId, rationale: "selected-session-module",
    });
    assert.equal(accepted.status, 200);
    for (let i = 0; i < 100 && adapter.requests().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 40));
    const events = await (await fetch(`${server.url}v1/tasks/${taskId}/events`, { headers })).json() as any;
    const decision = events.events.find((event: any) => event.type === "intervention.decided");
    assert.equal(decision.payload.optionId, option.optionId);
    const prompt = String(adapter.requests()[1]?.messages[0]?.content);
    assert.match(prompt, /selected-session-module/);
    assert.match(prompt, /question\\":\\"Choose a module/);
    assert.match(prompt, /selectedOptionLabel\\":\\"src\/session/);
    const plans = events.events.filter((event: any) => event.type === "context.plan_created");
    assert.ok(plans.length >= 2);
    const inputs = plans.at(-1).payload;
    const user = inputs.items.find((item: any) => item.ref.startsWith("human-decision:"));
    const question = inputs.items.find((item: any) => item.ref.startsWith("human-question:"));
    assert.equal(user.source.trustLevel, "user_confirmed");
    assert.equal(question.source.trustLevel, "untrusted");
    const ledger = await readLedger(fixture.paths.ledgerFile(taskId as never));
    assert.equal(question.source.locator, ledger.events.find(
      (event: any) => event.type === "intervention.requested" &&
        event.payload.interventionId === intervention.interventionId)?.eventId);
    assert.equal(user.source.locator, ledger.events.find(
      (event: any) => event.type === "intervention.decided")?.eventId);
  } finally { await server.close(); await removeFixture(fixture); }
});
