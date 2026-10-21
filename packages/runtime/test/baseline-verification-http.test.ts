import assert from "node:assert/strict";
import test from "node:test";

import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { startServer } from "../src/server.ts";
import {
  FIXED_SESSION,
  FINISH_ACTION,
  autonomyFor,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
} from "./fixture.ts";

test("authenticated HTTP baseline comparison is explicit, cancellable and observation-only", async () => {
  const fixture = await makeFixture();
  const runtime = await KeystoneRuntime.create({
    paths: fixture.paths,
    models: [createSequenceAdapter({
      descriptor: scriptedModelDescriptor({ id: "comparison-source" }),
      responses: [
        envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
        envelopeFor([FINISH_ACTION]),
      ],
    })],
  });
  const source = await runtime.runTask({
    workspacePath: fixture.root,
    request: "fix src/auth/session.js",
    references: [{ kind: "file", value: "src/auth/session.js" }],
    autonomy: autonomyFor(["src/auth/**"]),
    acceptContractAutomatically: true,
    maxSteps: 2,
  });
  const server = await startServer({ paths: fixture.paths, token: "baseline-http-token" });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
  try {
    const missingConfirmation = await fetch(`${base}/v1/tasks/${source.taskId}/verify-comparison`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmed: false }),
    });
    assert.equal(missingConfirmation.status, 409);

    const response = await fetch(`${base}/v1/tasks/${source.taskId}/verify-comparison`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmed: true, maxWallClockMs: 60_000, timeoutMs: 20_000 }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const report = (await response.json()) as {
      sourceTaskId: string;
      status: string;
      verdict: string;
      parentProofReused: boolean;
      evidenceLevel: null;
    };
    assert.equal(report.sourceTaskId, source.taskId);
    assert.equal(report.status, "observed");
    assert.equal(report.verdict, "baseline_failed_candidate_passed");
    assert.equal(report.parentProofReused, false);
    assert.equal(report.evidenceLevel, null);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
