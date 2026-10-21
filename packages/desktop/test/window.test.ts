/**
 * Native-window launcher + shell nonce gate.
 *
 * These tests never open a GUI: they resolve the helper path, prove the
 * launcher refuses loudly when the helper is missing, and prove the shell
 * mints its HttpOnly nonce cookie on the window's first navigation while
 * refusing unauthenticated `/desktop/*` probes.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveKeystonePaths } from "@keystone/kernel";

import { DesktopShell } from "../src/shell.ts";
import {
  launchNativeWindow,
  nativeWindowSupported,
  windowHelperPath,
} from "../src/window.ts";

/** A fake runtime: echoes the Authorization header it received. */
const STUB_SERVE = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ sawAuthorization: req.headers.authorization ?? null }));
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ port, token: "child-token" }));
});
`;

async function bootHome(): Promise<{ home: string; cliBin: string }> {
  const home = await mkdtemp(join(tmpdir(), "keystone-window-"));
  const cliBin = join(home, "stub-serve.mjs");
  await writeFile(cliBin, STUB_SERVE);
  return { home, cliBin };
}

test("the helper path resolves into the desktop package and support is honest", () => {
  const helper = windowHelperPath();
  assert.match(helper, /packages\/desktop\/bin\/keystone-window$/);
  // Support must track the real filesystem (and platform), not guess.
  assert.equal(nativeWindowSupported(), process.platform === "darwin" && existsSync(helper));
});

test("launchNativeWindow refuses to invent a window when the helper is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-launch-"));
  try {
    const missing = join(home, "no-such-helper");
    assert.throws(
      () => launchNativeWindow("http://127.0.0.1:9/", { helperPath: missing }),
      /native window helper is not built/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the first navigation mints the nonce cookie; probes without it are 403", async () => {
  const { home, cliBin } = await bootHome();
  const shell = new DesktopShell({
    paths: resolveKeystonePaths(home),
    cliBin,
    onBrowserOpen: () => undefined,
    nativeWindow: false,
  });
  await shell.start();
  try {
    // A loopback probe that only knows the port, not the nonce.
    const probe = await fetch(`${shell.origin()}desktop/bootstrap`);
    assert.equal(probe.status, 403);

    // The window's first navigation (?ks-shell=<nonce>) must mint the cookie.
    const entry = await fetch(`${shell.origin()}?ks-shell=${shell.shellNonce()}`);
    const cookies = entry.headers.getSetCookie();
    assert.ok(
      cookies.some((c) => c.startsWith(`ks_shell_nonce=${shell.shellNonce()}`) && c.includes("HttpOnly")),
      `expected HttpOnly nonce cookie, got: ${JSON.stringify(cookies)}`,
    );

    // Carrying the cookie (as the real webview would) unlocks shell routes.
    const authed = await fetch(`${shell.origin()}desktop/bootstrap`, {
      headers: { cookie: `ks_shell_nonce=${shell.shellNonce()}` },
    });
    assert.equal(authed.status, 200);

    // A wrong nonce is still refused.
    const wrong = await fetch(`${shell.origin()}desktop/bootstrap`, {
      headers: { "x-keystone-shell-nonce": "not-the-nonce" },
    });
    assert.equal(wrong.status, 403);
  } finally {
    await shell.close("test");
    await rm(home, { recursive: true, force: true });
  }
});
