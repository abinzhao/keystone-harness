/**
 * Cross-platform spawn target resolution.
 *
 * The function is pure and takes the platform as a parameter, so every branch
 * (including the Windows one) is exercised here without needing a Windows host.
 * The exact command lines matter: they are the contract that keeps a `.cmd`
 * launcher runnable on Windows while preserving the "no shell" guarantee.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpawnTarget } from "../src/index.ts";

test("POSIX passes the command and arguments through unchanged", () => {
  const target = resolveSpawnTarget("pnpm", ["run", "test"], { platform: "darwin" });
  assert.deepEqual(target, {
    command: "pnpm",
    args: ["run", "test"],
    windowsVerbatimArguments: false,
  });
});

test("Windows leaves a native executable alone so no shell is involved", () => {
  const target = resolveSpawnTarget("node", ["--version"], { platform: "win32" });
  assert.deepEqual(target, {
    command: "node",
    args: ["--version"],
    windowsVerbatimArguments: false,
  });
});

test("Windows runs a package-manager launcher through the command processor", () => {
  const target = resolveSpawnTarget("pnpm", ["run", "test"], {
    platform: "win32",
    comspec: "cmd.exe",
  });
  assert.equal(target.command, "cmd.exe");
  assert.equal(target.windowsVerbatimArguments, true);
  // Each argument is quoted and its metacharacters (including the added quotes)
  // are `^`-escaped; `cmd`'s `/s` handling removes exactly one level, leaving
  // `pnpm.cmd "run" "test"`.
  assert.deepEqual(target.args, ["/d", "/s", "/c", '"pnpm.cmd ^"run^" ^"test^""']);
});

test("Windows wraps an explicit .cmd path, adding no suffix twice", () => {
  const target = resolveSpawnTarget(
    "C:\\repo\\node_modules\\.bin\\tsc.cmd",
    ["--noEmit"],
    { platform: "win32", comspec: "cmd.exe" },
  );
  assert.equal(target.command, "cmd.exe");
  assert.equal(target.args[3], '"C:\\repo\\node_modules\\.bin\\tsc.cmd ^"--noEmit^""');
});

test("Windows escapes shell metacharacters instead of letting them run", () => {
  const target = resolveSpawnTarget("npm", ["run", "a&calc"], {
    platform: "win32",
    comspec: "cmd.exe",
  });
  // `&` becomes `^&`, so it stays part of the argument rather than chaining a
  // second command — the escaping is what keeps the shell boundary honest.
  assert.equal(target.args[3], '"npm.cmd ^"run^" ^"a^&calc^""');
});

test("the command processor defaults to %ComSpec% then cmd.exe", () => {
  const fromEnv = resolveSpawnTarget("npm", [], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(fromEnv.command, "C:\\Windows\\System32\\cmd.exe");

  const fallback = resolveSpawnTarget("npm", [], { platform: "win32", env: {} });
  assert.equal(fallback.command, "cmd.exe");
});
