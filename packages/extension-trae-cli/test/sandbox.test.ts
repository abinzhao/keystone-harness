import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { sandboxProfile, isolatedEnvironment, SANDBOX_EXECUTABLE } from "../src/sandbox.ts";
import { runBounded } from "../src/process.ts";

test("sanitized environment has only owned homes and never inherits secrets, hooks or Node options", () => {
  const env = isolatedEnvironment("/private/tmp/public", 43210, "synthetic");
  assert.equal(env["HOME"], "/private/tmp/public/home");
  assert.equal(env["CODEX_HOME"], "/private/tmp/public/home/.trae");
  assert.equal(env["NODE_OPTIONS"], undefined);
  assert.equal(env["TRAE_ACCESS_TOKEN"], undefined);
  assert.equal(env["OPENSSL_CONF"], "/dev/null");
  assert.equal(env["PATH"], "/usr/bin:/bin");
  assert.match(env["HTTPS_PROXY"]!, /^http:\/\/keystone:synthetic@127\.0\.0\.1:43210$/);
});

test("native Argos tracing is disabled and metrics/file logs use pinned HTTPS endpoints", () => {
  const env = isolatedEnvironment("/private/tmp/public");
  assert.equal(env["TRAECLI_TRACE_ENABLED"], "false");
  assert.equal(env["TRAECLI_TRACE_LOG_BODY"], "false");
  assert.equal(env["TRAECLI_METRICS_ENDPOINT"], "https://argos-data-collector.bytedance.net/v1/metrics");
  assert.equal(env["TRAECLI_FILE_LOG_ENDPOINT"], "https://argos-data-collector.bytedance.net/v1/logs");
});

test("sandbox profile is deny-default, exact executable, private data root and exact proxy only", () => {
  const profile = sandboxProfile("/public/traex", "/private/tmp/owned", 43210);
  assert.ok(profile.includes("(deny default)"));
  assert.ok(profile.includes('(literal "/public/traex")'));
  assert.ok(profile.includes('(remote tcp "localhost:43210")'));
  assert.ok(profile.includes('(deny file-write* (literal "/public/traex"))'));
  assert.equal(profile.includes("process-fork"), false);
  assert.equal(profile.includes('import "system.sb"'), false);
  assert.throws(() => sandboxProfile('/tmp/x") (allow default)', "/private/tmp/owned"), { code: "configuration" });
});

test("actual macOS sandbox denies outside reads/writes, symlink escape, child commands and direct sockets", {
  skip: process.platform !== "darwin",
}, async () => {
  const base = await realpath(await mkdtemp(tmpdir() + "/keystone-isolation-test-"));
  const root = base + "/isolated";
  const outside = base + "/project-data";
  const server = createServer((socket) => socket.destroy());
  let connects = 0;
  server.on("connection", () => connects++);
  try {
    await mkdir(root); await mkdir(root + "/home"); await mkdir(root + "/tmp");
    await writeFile(outside, "synthetic public marker");
    await symlink(outside, root + "/escape");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const executable = await realpath(process.execPath);
    const script = `
      const fs = require("node:fs"), cp = require("node:child_process"), net = require("node:net");
      const results = {};
      for (const [name,path] of [["outside",${JSON.stringify(outside)}],["escape",${JSON.stringify(root + "/escape")}]]) {
        try {fs.readFileSync(path); results[name]=false} catch {results[name]=true}
      }
      try {fs.writeFileSync(${JSON.stringify(outside)}, "bad"); results.write=false} catch {results.write=true}
      const child=cp.spawnSync("/bin/echo",["bad"]); results.child=!!child.error || child.status!==0;
      fs.writeFileSync("allowed", "synthetic");
      const socket=net.connect(${port},"127.0.0.1");
      socket.on("error",()=>{results.socket=true; console.log(JSON.stringify(results))});
      socket.on("connect",()=>{results.socket=false; socket.destroy(); console.log(JSON.stringify(results))});
    `;
    const result = await runBounded({ executable: SANDBOX_EXECUTABLE,
      args: ["-p", sandboxProfile(executable, root), executable, "--jitless", "-e", script],
      cwd: root, env: isolatedEnvironment(root), stdin: Buffer.alloc(0), timeoutMs: 3000, maxOutputBytes: 8192 });
    assert.deepEqual(JSON.parse(result.stdout.toString()), { outside: true, escape: true, write: true, child: true, socket: true });
    assert.equal(await readFile(outside, "utf8"), "synthetic public marker");
    assert.equal(await readFile(root + "/allowed", "utf8"), "synthetic");
    assert.equal(connects, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
});

test("actual macOS sandbox permits only the exact gateway port, not another localhost port", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(tmpdir() + "/keystone-port-test-"));
  const allowed = createServer((socket) => socket.destroy());
  const denied = createServer((socket) => socket.destroy());
  let deniedConnections = 0;
  denied.on("connection", () => deniedConnections++);
  try {
    for (const server of [allowed, denied]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (allowed.address() as { port: number }).port;
    const otherPort = (denied.address() as { port: number }).port;
    const executable = await realpath(process.execPath);
    const script = `
      const net = require("node:net");
      Promise.all([${port},${otherPort}].map(port=>new Promise(resolve=>{
        const socket=net.connect(port,"127.0.0.1");
        socket.on("error",()=>resolve(false));
        socket.on("connect",()=>{socket.destroy();resolve(true)});
      }))).then(results=>console.log(JSON.stringify(results)));
    `;
    const result = await runBounded({ executable: SANDBOX_EXECUTABLE,
      args: ["-p", sandboxProfile(executable, root, port), executable, "--jitless", "-e", script],
      cwd: root, env: isolatedEnvironment(root), stdin: Buffer.alloc(0), timeoutMs: 3000, maxOutputBytes: 8192 });
    assert.deepEqual(JSON.parse(result.stdout.toString()), [true, false]);
    assert.equal(deniedConnections, 0);
  } finally {
    for (const server of [allowed, denied]) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
