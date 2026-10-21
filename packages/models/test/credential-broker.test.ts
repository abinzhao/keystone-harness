import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as models from "../src/index.ts";

test("Keychain broker uses injected typed operations and projects handles only", async () => {
  const entries = new Map<string, string>();
  const requests: models.CredentialHelperRequest[] = [];
  const broker = new models.KeychainCredentialBroker({
    service: "keystone-test",
    invoke: async (input) => {
      requests.push(input);
      if (input["operation"] === "set") entries.set(input["handle"]!, input["secret"]!);
      if (input["operation"] === "delete") entries.delete(input["handle"]!);
      return {
        ok: true,
        ...(input["operation"] === "resolve" ? { secret: entries.get(input["handle"]!) } : {}),
        ...(input["operation"] === "list" ? {
          handles: [...entries.keys()].map((handle) => ({ handle, present: true })),
        } : {}),
      };
    },
  });
  await broker.set("main", "test-only-secret");
  assert.equal(await broker.resolve("main"), "test-only-secret");
  assert.equal(await broker.resolve("missing"), undefined);
  assert.deepEqual(await broker.listHandles(), [{ handle: "main", present: true }]);
  assert.equal(JSON.stringify(await broker.listHandles()).includes("test-only-secret"), false);
  await broker.delete("main");
  assert.equal(await broker.resolve("main"), undefined);
  assert.equal(requests[0]?.["service"], "keystone-test");
});

test("helper transport sends secrets through stdin, never argv, and sanitizes stderr", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-broker-"));
  try {
    const helper = join(home, "helper.mjs");
    await writeFile(helper, `
let data = "";
for await (const chunk of process.stdin) data += chunk;
const input = JSON.parse(data);
if (process.argv.includes(input.secret)) process.exit(9);
if (input.operation === "set") process.stdout.write(JSON.stringify({ok:true}));
else { process.stderr.write(input.secret); process.exit(2); }
`);
    const options = { helperPath: process.execPath, args: [helper] };
    const input = { operation: "set" as const, service: "keystone-test", handle: "main", secret: "test-only-secret" };
    assert.deepEqual(await models.invokeCredentialHelper(input, options), { ok: true });
    await assert.rejects(() => models.invokeCredentialHelper({ ...input, operation: "resolve" }, options),
      (error: Error) => !error.message.includes(input.secret) && /credential helper/.test(error.message));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy migration is explicit, verifies the target and preserves failed sources", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-migration-"));
  try {
    const source = new models.FileCredentialStore({ credentialsDir: home });
    await source.set("main", "test-only-secret");
    const target = new models.FileCredentialStore({ credentialsDir: join(home, "target") });
    await assert.rejects(() => models.migrateLegacyCredential(source, target, "main", {}), /explicit/);
    assert.equal(await target.resolve("main"), undefined);
    await assert.rejects(() => models.migrateLegacyCredential(source, {
      async set() {}, async resolve() { return "wrong"; }, async delete() {}, async listHandles() { return []; },
    }, "main", { confirmed: true, removeSource: true }), /verification/);
    assert.equal(await source.resolve("main"), "test-only-secret");
    await models.migrateLegacyCredential(source, target, "main", { confirmed: true });
    assert.equal(await source.resolve("main"), "test-only-secret");
    await models.migrateLegacyCredential(source, target, "main", { confirmed: true, removeSource: true });
    assert.equal(await source.resolve("main"), undefined);
    assert.equal(await target.resolve("main"), "test-only-secret");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("broker failures and unsafe handles never echo supplied data", async () => {
  const broker = new models.KeychainCredentialBroker({
    service: "keystone-test", invoke: async () => { throw new Error("test-only-secret"); },
  });
  for (const operation of [
    () => broker.set("main", "test-only-secret"), () => broker.resolve("main"),
    () => broker.set("../../test-only-secret", "test-only-secret"),
  ]) {
    await assert.rejects(operation, (error: Error) => !error.message.includes("test-only-secret"));
  }
});

for (const scenario of ["collision", "same-source"] as const) test(`migration refuses ${scenario}`, async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-migration-collision-"));
  try {
    const source = new models.FileCredentialStore({ credentialsDir: home });
    const target = new models.FileCredentialStore({ credentialsDir: join(home, "target") });
    await source.set("main", "source-secret");
    await target.set("main", "active-target-secret");
    if (scenario === "collision") {
      await assert.rejects(() => models.migrateLegacyCredential(source, target, "main", { confirmed: true }), /verification/);
      assert.equal(await target.resolve("main"), "active-target-secret");
    } else {
      await assert.rejects(() => models.migrateLegacyCredential(source, source, "main", {
        confirmed: true, removeSource: true,
      }));
    }
    assert.equal(await source.resolve("main"), "source-secret");
  } finally { await rm(home, { recursive: true, force: true }); }
});
