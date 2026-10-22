import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sandboxProfile, isolatedEnvironment, SANDBOX_EXECUTABLE } from "../src/sandbox.ts";
import { runBounded } from "../src/process.ts";
import { createTransport } from "../src/transport.ts";
import { lease } from "./fixtures.ts";

test("native CLI auth is read in place only; adjacent files and auth writes stay denied", { skip: process.platform !== "darwin" }, async () => {
  const base = await realpath(await mkdtemp(tmpdir() + "/keystone-auth-boundary-"));
  const root = base + "/isolated", auth = base + "/native/auth.json", adjacent = base + "/native/config";
  try {
    await mkdir(root); await mkdir(base + "/native");
    await writeFile(auth, "synthetic-public-auth-fixture"); await writeFile(adjacent, "private-config");
    const executable = await realpath(process.execPath);
    const profile = (sandboxProfile as any)(executable, root, undefined, auth);
    const script = `
      const fs=require("node:fs"); const result={};
      try {result.auth=fs.readFileSync(${JSON.stringify(auth)},"utf8")==="synthetic-public-auth-fixture"} catch {result.auth=false}
      try {fs.readFileSync(${JSON.stringify(adjacent)});result.adjacent=false}catch{result.adjacent=true}
      try {fs.writeFileSync(${JSON.stringify(auth)},"bad");result.write=false}catch{result.write=true}
      console.log(JSON.stringify(result));
    `;
    const result = await runBounded({
      executable: SANDBOX_EXECUTABLE, args: ["-p", profile, executable, "--jitless", "-e", script],
      cwd: root, env: isolatedEnvironment(root), stdin: Buffer.alloc(0), timeoutMs: 3000, maxOutputBytes: 4096,
    });
    assert.deepEqual(JSON.parse(result.stdout.toString()), { auth: true, adjacent: true, write: true });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("native model metadata is proposal-bound and readable through scratch without adjacent access or writes", {
  skip: process.platform !== "darwin",
}, async () => {
  const base = await realpath(await mkdtemp(tmpdir() + "/keystone-metadata-boundary-"));
  const metadata = base + "/models_cache.json", adjacent = base + "/config.toml";
  try {
    await writeFile(metadata, '{"model":"public-synthetic"}');
    await writeFile(adjacent, "synthetic-private-config");
    const transport = await createTransport({
      cliPath: process.execPath, endpointHost: "api.example.com", egressHosts: ["api.example.com"],
      isActive: () => true, nativeModelsFile: metadata,
    } as Parameters<typeof createTransport>[0]);
    const script = `
      const fs=require("node:fs"), p=process.env.TRAE_HOME+"/models_cache.json", result={};
      try{result.metadata=fs.readFileSync(p,"utf8")==='{"model":"public-synthetic"}'}catch{result.metadata=false}
      try{fs.readFileSync(${JSON.stringify(adjacent)});result.adjacent=false}catch{result.adjacent=true}
      try{fs.writeFileSync(p,"bad");result.write=false}catch{result.write=true}
      console.log(JSON.stringify(result));
    `;
    const prepared = transport.prepare("generate", ["--jitless", "-e", script, "--"]);
    assert.equal((prepared.proposal.parameters as any).nativeModelsFile, metadata);
    const output = await prepared.execute(async proposal => lease(proposal));
    assert.deepEqual(JSON.parse(output.toString()), { metadata: true, adjacent: true, write: true });
    assert.equal(await readFile(metadata, "utf8"), '{"model":"public-synthetic"}');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("confined TLS uses only the fixed read-only public system CA bundle without private trust configuration", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(tmpdir() + "/keystone-public-ca-"));
  try {
    const executable = await realpath(process.execPath), env = isolatedEnvironment(root);
    const result = await runBounded({
      executable: SANDBOX_EXECUTABLE,
      args: ["-p", sandboxProfile(executable, root), executable, "--jitless", "-e", `
        const fs=require("node:fs"),p=process.env.SSL_CERT_FILE,result={path:p,read:false,write:false};
        try{fs.accessSync(p,fs.constants.R_OK);result.read=true}catch{}
        try{fs.accessSync(p,fs.constants.W_OK);result.write=true}catch{}
        console.log(JSON.stringify(result));`],
      cwd: root, env, stdin: Buffer.alloc(0), timeoutMs: 3000, maxOutputBytes: 4096,
    });
    assert.deepEqual(JSON.parse(result.stdout.toString()), { path: "/private/etc/ssl/cert.pem", read: true, write: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery declares only exact native resources, while offline probes expose none", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(tmpdir() + "/keystone-discovery-resources-"));
  try {
    const auth = root + "/auth.json", metadata = root + "/models_cache.json";
    await writeFile(auth, "synthetic"); await writeFile(metadata, "synthetic");
    const transport = await createTransport({
      cliPath: process.execPath, endpointHost: "api.example.com", egressHosts: ["api.example.com"],
      nativeAuthFile: auth, nativeModelsFile: metadata,
    });
    const discovery = transport.prepare("models", ["models", "--json"]).proposal.parameters;
    assert.equal(discovery.nativeAuthFile, auth);
    assert.equal(discovery.nativeModelsFile, metadata);
    assert.equal(discovery.args.includes("--no-daemon"), false);
    for (const purpose of ["version", "help"] as const) {
      const p = transport.prepare(purpose, ["--version"]).proposal.parameters;
      assert.equal(p.nativeAuthFile, undefined);
      assert.equal(p.nativeModelsFile, undefined);
      assert.equal(p.maxNetworkBytes, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
