import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { runBounded } from "../src/process.ts";

function run(script: string, extra = {}) {
  return runBounded({
    executable: process.execPath, args: ["-e", script], cwd: tmpdir(), env: {},
    stdin: Buffer.from("public input"), timeoutMs: 2000, maxOutputBytes: 4096, ...extra,
  });
}

test("subprocess receives stdin, reports zero exit and never returns stderr", async () => {
  const result = await run('process.stdin.pipe(process.stdout); process.stderr.write("PRIVATE")');
  assert.equal(result.stdout.toString(), "public input");
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("nonzero and missing executables return fixed errors without diagnostics", async () => {
  await assert.rejects(run('process.stderr.write("PRIVATE"); process.exitCode = 3'), { code: "cli_failed" });
  await assert.rejects(run("", { executable: "/missing-public-executable" }), { code: "cli_failed" });
});

test("stdout and stderr floods are terminated at the combined byte bound", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(run(`setInterval(() => process.${stream}.write("x".repeat(65536)), 1)`),
      { code: "output_limit" });
  }
});

test("timeout kills a real process group, including a child retaining pipes", async () => {
  let childPid = 0;
  const started = Date.now();
  await assert.rejects(run(`
    const {spawn} = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"inherit"});
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(()=>{},1000);
  `, { timeoutMs: 200, onStdout: (chunk: Buffer) => { childPid = Number(chunk.toString().trim()); } }),
  { code: "timeout" });
  assert.ok(Date.now() - started < 2500);
  assert.ok(childPid > 0);
  await delay(50);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("cancellation rejects before spawn and kills a running process", async () => {
  const already = new AbortController();
  already.abort();
  await assert.rejects(run("", { signal: already.signal }), { code: "cancelled" });
  const controller = new AbortController();
  let pid = 0;
  const task = run('process.stdout.write(String(process.pid)); setInterval(()=>{},1000)',
    { signal: controller.signal, onStdout: (chunk: Buffer) => { pid = Number(chunk.toString()); controller.abort(); } });
  await assert.rejects(task, { code: "cancelled" });
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("decoder refusal also terminates a producer and does not leak exception text", async () => {
  await assert.rejects(run('process.stdout.write("bad"); setInterval(()=>{},1000)',
    { onStdout: () => { throw new Error("PRIVATE parser text"); } }), { code: "protocol" });
});
