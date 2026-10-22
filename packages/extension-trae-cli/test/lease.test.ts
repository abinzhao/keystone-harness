import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parametersHash, consumeLease } from "../src/transport.ts";
import { proposal, lease } from "./fixtures.ts";

test("parameter hash exactly matches Keystone sorted canonical contentHash", () => {
  const expected = createHash("sha256").update('{"a":[2,{"x":true}],"b":1}').digest("hex");
  assert.equal(parametersHash({ b: 1, a: [2, { x: true }] }), expected);
  assert.equal(parametersHash({ a: [2, { x: true }], b: 1 }), expected);
});

test("exact lease succeeds once and cannot be reused across transport instances", () => {
  const p = proposal(), l = lease(p);
  consumeLease(p, l);
  assert.throws(() => consumeLease(p, l), { code: "authorization" });
  assert.equal(l.consumedCalls, 0, "transport never rewrites kernel state");
});

test("wrong subject, command, arguments, input, expiry and budgets all fail before execution", () => {
  const p = proposal();
  for (const patch of [
    { issuedBy: "extension" }, { status: "revoked" }, { consumedCalls: 1 },
    { subject: { kind: "builder", id: "trae-cli" } }, { subject: { kind: "extension", id: "other" } },
    { resource: { kind: "command", mode: "execute", values: ["/bin/sh"] } },
    { resource: { ...p.resource, values: [...p.resource.values, "/bin/sh"] } },
    { expiresAt: new Date(0).toISOString() }, { issuedAt: new Date(Date.now() + 10000).toISOString() },
    { scopeDigest: "invalid" }, { budget: { maxCalls: 2 } }, { budget: { maxCalls: 1, maxBytes: 1 } },
    { budget: { maxCalls: 1, maxBytes: Number.NaN } }, { budget: { maxCalls: 1, maxWallClockMs: Number.NaN } },
    { constraints: { ...lease(p).constraints, parametersHash: "0".repeat(64) } },
    { constraints: { ...lease(p).constraints, workingDirectory: "/actual/project" } },
    { constraints: { ...lease(p).constraints, timeoutMs: 1001 } },
    { constraints: { ...lease(p).constraints, argvPrefix: [] } },
    { constraints: { ...lease(p).constraints, argvPrefix: ["-f"] } },
  ]) assert.throws(() => consumeLease(p, { ...lease(p), ...patch }), { code: "authorization" });
  for (const patch of [{ args: ["/bin/sh"] }, { stdinHash: "0".repeat(64) }, { cwd: "/project" }]) {
    assert.throws(() => consumeLease({ ...p, parameters: { ...p.parameters, ...patch } }, lease(p)), { code: "authorization" });
  }
});
