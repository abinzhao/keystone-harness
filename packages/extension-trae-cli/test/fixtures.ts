import { spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parametersHash } from "../src/transport.ts";
import type { TransportProposal, TransportLease } from "../src/types.ts";

export function proposal(): TransportProposal {
  const parameters = {
    command: "/usr/bin/sandbox-exec", args: ["-p", "deny default", "/public/traex", "--no-daemon", "--version"],
    cwd: "/private/tmp/owned/work", temporaryRoot: "/private/tmp/owned", stdinHash: "a".repeat(64), stdinBytes: 0, environmentHash: "b".repeat(64),
    cliDigest: "c".repeat(64), sourceExecutable: "/public/traex", purpose: "version" as const, timeoutMs: 1000, maxOutputBytes: 4096,
    maxNetworkBytes: 0, egressHosts: [],
  };
  return { subject: { kind: "extension", id: "trae-cli" }, capability: "cmd.exec",
    resource: { kind: "command", values: [parameters.command], mode: "execute" },
    parameters, parametersHash: parametersHash(parameters) };
}
export function lease(p: TransportProposal): TransportLease {
  return { leaseId: "lease-" + randomUUID(), taskId: "task-public", branchId: "branch-public",
    subject: p.subject, capability: p.capability, resource: p.resource,
    constraints: { workingDirectory: p.parameters.cwd, timeoutMs: p.parameters.timeoutMs,
      maxOutputBytes: p.parameters.maxOutputBytes, argvPrefix: p.parameters.args.slice(0, 1),
      parametersHash: p.parametersHash },
    budget: { maxCalls: 1, maxBytes: p.parameters.maxOutputBytes + p.parameters.maxNetworkBytes + p.parameters.stdinBytes,
      maxWallClockMs: p.parameters.timeoutMs },
    scopeDigest: "d".repeat(64), issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(), issuedBy: "kernel", status: "active", consumedCalls: 0 };
}

export async function nativeFixture(): Promise<{ root: string; executable: string }> {
  const root = await realpath(await mkdtemp(tmpdir() + "/keystone-cli-fixture-"));
  const executable = root + "/traex";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/cc", ["-O0", "-o", executable, fileURLToPath(new URL("./fixture.c", import.meta.url))],
      { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error("Synthetic CLI fixture compilation failed.")));
  });
  return { root, executable };
}

export function hello(host: string): Buffer {
  const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
  const name = Buffer.from(host);
  const names = Buffer.concat([u16(name.length + 3), Buffer.from([0]), u16(name.length), name]);
  const ext = Buffer.concat([u16(0), u16(names.length), names]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]),
    u16(2), Buffer.from([0x13, 1, 1, 0]), u16(ext.length), ext]);
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(handshake.length), handshake]);
}
