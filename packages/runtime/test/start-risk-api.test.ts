/**
 * Server-authoritative start grading over the real Run Protocol (ADR-0013).
 *
 * Drives the real server against a real Git repository so the enforcement that
 * matters — a low-risk write can auto-start, a policy-gated write must be
 * confirmed, and a dirty overlap is refused with recovery — is exercised end to
 * end rather than asserted on a mock.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";

import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";

import { startServer } from "../src/index.ts";
import {
  FIXED_SESSION,
  FINISH_ACTION,
  envelopeFor,
  makeFixture,
  removeFixture,
  writeAction,
  type Fixture,
} from "./fixture.ts";

const TOKEN = "start-risk-token-0123456789";

async function api(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function scripted() {
  return createSequenceAdapter({
    descriptor: scriptedModelDescriptor({ id: "builder" }),
    responses: [
      envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]),
      envelopeFor([FINISH_ACTION]),
    ],
  });
}

test("a clean, low-risk write previews as auto_start and starts without an explicit confirm", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths, models: [scripted()], token: TOKEN });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await api(base, "/v1/contract/preview", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.risk.decision, "auto_start", JSON.stringify(preview.body.risk));

    // startMode "auto" is honored for a low-risk grade.
    const started = await api(base, "/v1/tasks", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh in src/auth/session.js.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
      startMode: "auto",
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("the user 'confirm all writes' toggle forces confirmation; starting without it is refused", async () => {
  const fixture = await makeFixture();
  const server = await startServer({ paths: fixture.paths, models: [scripted()], token: TOKEN });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await api(base, "/v1/contract/preview", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
      confirmAllWrites: true,
    });
    assert.equal(preview.body.risk.decision, "require_confirmation");
    assert.ok(preview.body.risk.reasons.includes("policy_required"));

    // Starting without an explicit confirmation is a 409, not a silent start.
    // A client cannot self-attest a safer grade.
    const refused = await api(base, "/v1/tasks", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
      confirmAllWrites: true,
      // no startMode: "confirmed"
    });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /needs confirmation/);

    // An explicit confirmation is accepted.
    const accepted = await api(base, "/v1/tasks", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
      confirmAllWrites: true,
      startMode: "confirmed",
    });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});

test("a dirty worktree that overlaps the write scope is refused with a recovery path", async () => {
  const fixture: Fixture = await makeFixture();
  // Leave an uncommitted edit in the very directory the task wants to write.
  await writeFile(
    `${fixture.root}/src/auth/session.js`,
    "// user's uncommitted in-progress edit\nmodule.exports = {};\n",
  );
  const server = await startServer({ paths: fixture.paths, models: [scripted()], token: TOKEN });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await api(base, "/v1/contract/preview", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
    });
    assert.equal(preview.body.risk.decision, "refuse");
    assert.ok(preview.body.risk.dirtyOverlap.includes("src/auth/session.js"));
    assert.match(String(preview.body.risk.recovery), /commit or stash/i);

    // The start path re-derives the grade and refuses too: the preview is not
    // the only enforcement point.
    const started = await api(base, "/v1/tasks", {
      workspacePath: fixture.root,
      request: "Fix the duplicate session refresh.",
      references: [{ kind: "directory", value: "src" }],
      writePaths: ["src/**"],
      allowedCommands: ["node", "npm"],
      startMode: "confirmed",
    });
    assert.equal(started.status, 409);
    assert.match(String(started.body.error), /commit or stash/i);
  } finally {
    await server.close();
    await removeFixture(fixture);
  }
});
