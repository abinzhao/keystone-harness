import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as models from "../src/index.ts";

test("migrated roots retain Keychain identity without resolving or exporting secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-explicit-identity-"));
  try {
    const service = models.credentialServiceName(join(home, "original", "credentials"));
    assert.notEqual(service, models.credentialServiceName(join(home, "migrated", "credentials")));
    const calls: models.CredentialHelperRequest[] = [];
    const broker = models.createCredentialBroker({
      native: true, credentialsDir: join(home, "migrated", "credentials"), service,
      invoke: async (request) => { calls.push(request); return { ok: true, handles: [{ handle: "main", present: true }] }; },
    });
    assert.deepEqual(await broker.listHandles(), [{ handle: "main", present: true }]);
    assert.deepEqual(calls, [{ operation: "list", service }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("default broker identity survives copy/verify/switch without copying secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-broker-identity-"));
  try {
    const original = join(home, "original");
    const migrated = join(home, "migrated");
    const requests: models.CredentialHelperRequest[] = [];
    const invoke: models.CredentialHelperInvoker = async (input) => {
      requests.push(input); return { ok: true, handles: [{ handle: "main", present: true }] };
    };
    const first = models.createCredentialBroker({ credentialsDir: join(original, "credentials"), native: true, invoke });
    await first.listHandles();
    const identity = await readFile(join(original, "credential-service.json"), "utf8");
    assert.deepEqual(JSON.parse(identity), { version: "1.0.0", service: requests[0]?.service });
    assert.equal(identity.includes("secret"), false);
    await cp(original, migrated, { recursive: true });
    const next = models.createCredentialBroker({ credentialsDir: join(migrated, "credentials"), native: true, invoke });
    await next.listHandles();
    assert.equal(requests[0]?.service, requests[1]?.service);
    assert.equal(requests.every((input) => input.operation === "list"), true);
    assert.notEqual(requests[1]?.service, models.credentialServiceName(join(migrated, "credentials")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid durable identity fails closed without guessing a new namespace", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-broker-identity-"));
  try {
    await writeFile(join(home, "credential-service.json"), "fixture-private-key");
    assert.throws(() => models.createCredentialBroker({ credentialsDir: join(home, "credentials"), native: true }),
      (error: Error) => !error.message.includes("fixture-private-key"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
