import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveKeystonePaths } from "@keystone/kernel";
import { KeychainCredentialBroker } from "@keystone/models";
import { DesktopShell } from "../src/shell.ts";

test("desktop migration keeps the runtime and moves subsequent native settings writes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "keystone-desktop-migration-"));
  const home = await mkdtemp(join(parent, "home-"));
  const destination = join(parent, "destination");
  const secrets = new Map<string, string>();
  const credentials = new KeychainCredentialBroker({
    service: "net.keystone.credentials.test",
    invoke: async (input) => {
      if (input.operation === "set") secrets.set(input.handle!, input.secret!);
      if (input.operation === "delete") secrets.delete(input.handle!);
      return {
        ok: true,
        ...(input.operation === "resolve" ? { secret: secrets.get(input.handle!) } : {}),
        ...(input.operation === "list" ? {
          handles: [...secrets.keys()].map((handle) => ({ handle, present: true })),
        } : {}),
      };
    },
  });
  let launches = 0;
  const shell = new DesktopShell({
    paths: resolveKeystonePaths(home), credentials, onBrowserOpen() {}, onRuntimeReady() { launches++; },
  });
  await shell.start();
  const headers = { "x-keystone-shell-nonce": shell.shellNonce(), "content-type": "application/json" };
  try {
    const migrated = await fetch(`${shell.origin()}v1/data/migrate`, {
      method: "POST", headers, body: JSON.stringify({ destination, preview: false }),
    });
    assert.equal(migrated.status, 200, await migrated.clone().text());
    const result = await migrated.json() as { newHome: string };
    const config = await fetch(`${shell.origin()}desktop/config`, { headers }).then((response) => response.json()) as { revision: string };
    const saved = await fetch(`${shell.origin()}desktop/config/save`, {
      method: "POST", headers, body: JSON.stringify({
        revision: config.revision, baseUrl: "http://127.0.0.1:11434/v1", modelName: "fixture", protocol: "openai-chat",
      }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.match(await readFile(join(result.newHome, "config.json"), "utf8"), /fixture/);
    await assert.rejects(readFile(join(home, "config.json"), "utf8"), { code: "ENOENT" });
    assert.deepEqual([...secrets.values()], [""]);
    assert.equal(launches, 1);
  } finally { await shell.close("test"); await rm(parent, { recursive: true, force: true }); }
});
