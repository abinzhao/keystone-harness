import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveKeystonePaths } from "@keystone/kernel";
import { FileCredentialStore, type KeystoneConfig } from "@keystone/models";
import { DesktopShell } from "../src/shell.ts";

test("settings proxy is nonce-gated and desktop save refreshes without restarting", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-settings-shell-"));
  const paths = resolveKeystonePaths(home);
  let launches = 0;
  const shell = new DesktopShell({ paths,
    credentials: new FileCredentialStore({ credentialsDir: paths.credentialsDir }),
    cliBin: fileURLToPath(new URL("fixtures/settings-runtime.mjs", import.meta.url)),
    onBrowserOpen() {}, onRuntimeReady() { launches++; },
  });
  await shell.start();
  try {
    const url = `${shell.origin()}v1/settings`;
    assert.equal((await fetch(url)).status, 403);
    const headers = { "x-keystone-shell-nonce": shell.shellNonce(), "content-type": "application/json" };
    const before = await fetch(url, { headers }).then((response) => response.json()) as {
      revision: string; config: KeystoneConfig; pid: number; home: string;
    };
    assert.equal(before.home, home);
    const config = await fetch(`${shell.origin()}desktop/config`, { headers })
      .then((response) => response.json()) as { revision: string };
    const saved = await fetch(`${shell.origin()}desktop/config/save`, {
      method: "POST", headers, body: JSON.stringify({
        revision: config.revision, baseUrl: "http://127.0.0.1:11434/v1",
        protocol: "gemini-generate", modelName: "fixture", apiKey: "fixture-only-secret", multimodal: true,
      }),
    });
    assert.equal(saved.status, 200);
    const result = await saved.json() as { ok: boolean; runtimeNotified: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.runtimeNotified, true);
    const after = await fetch(url, { headers }).then((response) => response.json()) as typeof before;
    assert.equal(after.pid, before.pid);
    assert.equal(launches, 1);
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.config.models[0]?.protocol, "gemini-generate");
    assert.equal(after.config.models[0]?.multimodal, true);
    assert.equal(JSON.stringify(after).includes("fixture-only-secret"), false);
    const update = { revision: after.revision, config: after.config, presentation: { language: "zh-CN" } };
    const posted = await fetch(url, { method: "POST", headers, body: JSON.stringify(update) })
      .then((response) => response.json()) as { received: unknown; sawAuthorization: string };
    assert.deepEqual(posted.received, update);
    assert.equal(posted.sawAuthorization, "Bearer fixture-token");
    const stale = await fetch(`${shell.origin()}desktop/config/save`, {
      method: "POST", headers, body: JSON.stringify({
        revision: "missing", baseUrl: "http://127.0.0.1:11434/v1",
        modelName: "fixture", apiKey: "fixture-only-secret",
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.text()).includes("fixture-only-secret"), false);
    const crossOrigin = await fetch(url, { headers: { ...headers, origin: "http://localhost:9999" } });
    assert.equal(crossOrigin.status, 403);
  } finally { await shell.close("test"); await rm(home, { recursive: true, force: true }); }
});
