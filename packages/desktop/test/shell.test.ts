/**
 * Shell integration tests against a stubbed `keystone serve`.
 *
 * The stub pretends to be the Run Protocol runtime: it prints the JSON startup
 * record the shell parses, then on every request echoes the Authorization header
 * it received. That lets us prove the shell (a) proxies same-origin, (b) injects
 * the bearer token upstream so the page never holds it, and (c) refuses a second
 * instance — without booting the whole Keystone runtime.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveKeystonePaths } from "@keystone/kernel";

import { acquireInstanceLock, DesktopShell, InstanceAlreadyRunningError } from "../src/index.ts";

/** A fake runtime: prints its startup record, then echoes the auth header it saw. */
const STUB_SERVE = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ sawAuthorization: req.headers.authorization ?? null, url: req.url }));
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ port, token: "child-token-xyz" }));
});
`;

async function bootHome(): Promise<{ home: string; cliBin: string }> {
  const home = await mkdtemp(join(tmpdir(), "keystone-shell-"));
  const cliBin = join(home, "stub-serve.mjs");
  await writeFile(cliBin, STUB_SERVE);
  return { home, cliBin };
}

test("the shell proxies same-origin and injects the bearer token upstream", async () => {
  const { home, cliBin } = await bootHome();
  const shell = new DesktopShell({
    paths: resolveKeystonePaths(home),
    cliBin,
    onBrowserOpen: () => undefined,
  });
  await shell.start();
  try {
    const res = await fetch(`${shell.origin()}v1/capabilities`);
    const body = (await res.json()) as { sawAuthorization: string; url: string };
    // The shell authenticated upstream on the page's behalf.
    assert.equal(body.sawAuthorization, "Bearer child-token-xyz");
    assert.equal(body.url, "/v1/capabilities");

    // Shell-private routes require the nonce (carried as a header in tests).
    const boot = (await fetch(`${shell.origin()}desktop/bootstrap`, {
      headers: { "x-keystone-shell-nonce": shell.shellNonce() },
    }).then((r) => r.json())) as { shell: boolean; hasModel: boolean };
    assert.equal(boot.shell, true);
    assert.equal(boot.hasModel, false);
  } finally {
    await shell.close("test");
    await rm(home, { recursive: true, force: true });
  }
});

test("the lock refuses a live foreign holder but recovers from a stale pid", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-lock-"));
  // A real foreign (different OS pid) process holding the lock must block us.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(holder.pid && holder.pid !== process.pid);
  try {
    await writeFile(join(home, "desktop.lock"), `${holder.pid}\n`, { mode: 0o600 });
    await assert.rejects(() => acquireInstanceLock(home), InstanceAlreadyRunningError);

    // Once the holder is gone the lock is stale and may be re-taken.
    holder.kill();
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    const lock = await acquireInstanceLock(home);
    assert.equal(lock.holderPid, process.pid);
    await lock.release();
  } finally {
    if (!holder.killed) holder.kill();
    await rm(home, { recursive: true, force: true });
  }
});
