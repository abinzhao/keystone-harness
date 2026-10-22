import assert from "node:assert/strict";
import test from "node:test";
import { createScriptedAdapter, createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { autonomyFor, envelopeFor, FINISH_ACTION, FIXED_SESSION, writeAction, fixtureTestsPass, makeFixture, removeFixture } from "./fixture.ts";

test("next model step receives actual command output with untrusted provenance", async () => {
  const fixture = await makeFixture();
  const prompts: string[] = [];
  try {
    const model = createScriptedAdapter({
      descriptor: scriptedModelDescriptor({ id: "reader" }),
      respond: (request: any) => {
        prompts.push(String(request.messages[0].content));
        return prompts.length === 1 ? envelopeFor([{
            intent: "execute", tool: "cmd.run", parameters: { command: "node", args: ["-e", "console.log('COMMAND_' + (23 * 17))"] },
            rationale: "Inspect runtime output", expected_effects: [], requested_capabilities: ["cmd.exec"],
            produces_evidence_for: [], reversibility: "reversible",
          }]) : envelopeFor([FINISH_ACTION]);
      },
    } as any);
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [model] });
    await runtime.runTask({
      workspacePath: fixture.root, request: "Inspect session",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]), maxSteps: 3,
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /COMMAND_391/);
    assert.match(prompts[1]!, /cmd\.run/);
    assert.match(prompts[1]!, /DATA|untrusted/i);
  } finally { await removeFixture(fixture); }
});

for (const tool of ["fs.read_file", ""]) test(`a later finish marker with tool ${JSON.stringify(tool)} cannot cancel the first leased action`, async () => {
  const fixture = await makeFixture();
  try {
    assert.equal(await fixtureTestsPass(fixture.root), false);
    const model = createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "mixed-finish" }),
      responses: [envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION), { ...FINISH_ACTION, tool }]),
        envelopeFor([FINISH_ACTION])],
    });
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [model] });
    const result = await runtime.runTask({
      workspacePath: fixture.root, request: "Fix duplicate session refresh",
      references: [{ kind: "directory", value: "src" }],
      autonomy: autonomyFor(["src/**"]), maxSteps: 3,
    });
    assert.equal(await fixtureTestsPass(fixture.root), true, "the first proposal must actually change the failing project");
    assert.equal(result.status, "proven");
    assert.equal(model.callCount(), 2, "later actions are replanned rather than executed as a batch");
  } finally { await removeFixture(fixture); }
});
