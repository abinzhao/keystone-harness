/**
 * Regression test for the engineering action-resolution policy (ADR-0006, M1).
 *
 * This pins that `resolveEngineeringAction` reproduces, byte-for-byte, the
 * intent→capability and tool→resource mapping that used to be hard-coded in
 * `packages/kernel/src/kernel.ts`. The kernel now defines the seam; this pack owns
 * the engineering mapping, and these tests prove nothing about that mapping
 * drifted when it moved.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { actionProposalSchema, newId, type ActionProposal } from "@keystone/schemas";

import { resolveEngineeringAction } from "../src/index.ts";

function proposal(overrides: Partial<{
  intent: ActionProposal["intent"];
  toolId: string;
  parameters: Record<string, unknown>;
  expectedEffects: ActionProposal["expectedEffects"];
  requestedCapabilities: ActionProposal["requestedCapabilities"];
}> = {}): ActionProposal {
  return actionProposalSchema.parse({
    proposalId: newId("prop"),
    taskId: newId("task"),
    branchId: newId("branch"),
    stepId: "step.localize",
    at: new Date().toISOString(),
    modelRef: { id: "scripted", provider: "keystone", modelName: "scripted-1" },
    intent: overrides.intent ?? "write",
    tool: { id: overrides.toolId ?? "fs.write_file", version: "1.0.0" },
    parameters: overrides.parameters ?? { path: "src/x.ts", content: "// fix" },
    rationale: "apply the change",
    expectedEffects: overrides.expectedEffects ?? [
      { kind: "file_modify", target: "src/x.ts", description: "edit" },
    ],
    reversibility: "reversible",
    requestedCapabilities: overrides.requestedCapabilities ?? [],
    producesEvidenceFor: [],
  }) as ActionProposal;
}

test("maps each engineering intent to its capability", () => {
  assert.equal(resolveEngineeringAction(proposal({ intent: "read" })).capability, "fs.read");
  assert.equal(resolveEngineeringAction(proposal({ intent: "search" })).capability, "fs.read");
  assert.equal(resolveEngineeringAction(proposal({ intent: "write" })).capability, "fs.write");
  assert.equal(resolveEngineeringAction(proposal({ intent: "delete" })).capability, "fs.delete");
  assert.equal(resolveEngineeringAction(proposal({ intent: "execute" })).capability, "cmd.exec");
  assert.equal(resolveEngineeringAction(proposal({ intent: "network" })).capability, "net.fetch");

  // git defaults to read, and only escalates to write when explicitly requested.
  assert.equal(resolveEngineeringAction(proposal({ intent: "git" })).capability, "git.read");
  assert.equal(
    resolveEngineeringAction(
      proposal({ intent: "git", requestedCapabilities: ["git.write"] }),
    ).capability,
    "git.write",
  );

  // Conversational intents are not leasable -> the kernel default-denies them.
  assert.equal(resolveEngineeringAction(proposal({ intent: "ask_user" })).capability, undefined);
  assert.equal(resolveEngineeringAction(proposal({ intent: "finish" })).capability, undefined);
});

test("resolves tool-specific resource values", () => {
  assert.deepEqual(
    resolveEngineeringAction(
      proposal({ toolId: "fs.read_file", parameters: { path: "README.md" } }),
    ).resourceValues,
    ["README.md"],
  );
  assert.deepEqual(
    resolveEngineeringAction(proposal({ toolId: "fs.write_file" })).resourceValues,
    ["src/x.ts"],
  );
  // A file tool with no path names no resource.
  assert.deepEqual(
    resolveEngineeringAction(
      proposal({ toolId: "fs.list_dir", parameters: {} }),
    ).resourceValues,
    [],
  );
  assert.deepEqual(
    resolveEngineeringAction(
      proposal({ toolId: "fs.search_text", parameters: { glob: "**/*.ts" } }),
    ).resourceValues,
    ["**/*.ts"],
  );
  // Search defaults the glob.
  assert.deepEqual(
    resolveEngineeringAction(
      proposal({ toolId: "fs.search_text", parameters: {} }),
    ).resourceValues,
    ["**"],
  );
  assert.deepEqual(
    resolveEngineeringAction(
      proposal({ toolId: "cmd.run", parameters: { command: "pnpm test" } }),
    ).resourceValues,
    ["pnpm test"],
  );
  // Read-only git tools touch the whole worktree.
  assert.deepEqual(
    resolveEngineeringAction(proposal({ toolId: "git.status" })).resourceValues,
    ["."],
  );
  assert.deepEqual(
    resolveEngineeringAction(proposal({ toolId: "git.diff" })).resourceValues,
    ["."],
  );
});

test("an extension-provided tool names its declared expected effects", () => {
  const result = resolveEngineeringAction(
    proposal({
      toolId: "ext.custom_tool",
      expectedEffects: [
        { kind: "file_modify", target: "a.ts", description: "edit a" },
        { kind: "file_create", target: "b.ts", description: "create b" },
      ],
    }),
  );
  assert.deepEqual(result.resourceValues, ["a.ts", "b.ts"]);
});
