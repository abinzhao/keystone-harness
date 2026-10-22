import { createHash, randomInt, randomUUID, randomBytes } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, mkdir, realpath, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { TraeCliError } from "./errors.ts";
import { OUTPUT_SCHEMA } from "./codec.ts";
import { GatewayPortInUseError, startGateway, safeHost, type Gateway } from "./gateway.ts";
import { SANDBOX_EXECUTABLE, SYSTEM_CA_BUNDLE, isolatedEnvironment, sandboxProfile } from "./sandbox.ts";
import { runBounded } from "./process.ts";
import type { AuthorizeTransport, TransportProposal, TransportLease, TraeCliOptions } from "./types.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  throw new TraeCliError("configuration");
}
export function parametersHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function requireLive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TraeCliError("cancelled");
}
async function cancelAware<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  requireLive(signal);
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new TraeCliError("cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { requireLive(signal); return work(); }).then(
      value => { requireLive(signal); resolve(value); }, reject,
    ).catch(reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
const usedLeases = new Set<string>();
export function consumeLease(proposal: TransportProposal, lease: TransportLease): void {
  try {
    const p = proposal.parameters, c = lease.constraints, b = lease.budget;
    const now = Date.now(), issued = Date.parse(lease.issuedAt), expires = Date.parse(lease.expiresAt);
    if (!lease.leaseId || !lease.taskId || !lease.branchId || usedLeases.has(lease.leaseId) ||
        lease.issuedBy !== "kernel" || lease.status !== "active" || lease.consumedCalls !== 0 ||
        lease.subject.kind !== "extension" || lease.subject.id !== proposal.subject.id ||
        lease.capability !== "cmd.exec" || proposal.capability !== "cmd.exec" ||
        lease.resource.kind !== "command" || lease.resource.mode !== "execute" ||
        lease.resource.values.length !== 1 || lease.resource.values[0] !== p.command ||
        parametersHash(proposal.resource) !== parametersHash(lease.resource) ||
        parametersHash(p) !== proposal.parametersHash || c.parametersHash !== proposal.parametersHash ||
        c.workingDirectory !== p.cwd || c.timeoutMs !== p.timeoutMs || c.maxOutputBytes !== p.maxOutputBytes ||
        !c.argvPrefix?.length || c.argvPrefix.some((arg, index) => p.args[index] !== arg) ||
        !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now ||
        !/^[a-f0-9]{64}$/.test(lease.scopeDigest) || b.maxCalls !== 1 ||
        (b.maxBytes !== undefined && (!Number.isSafeInteger(b.maxBytes) || b.maxBytes < p.maxOutputBytes + p.maxNetworkBytes + p.stdinBytes)) ||
        (b.maxWallClockMs !== undefined && (!Number.isSafeInteger(b.maxWallClockMs) || b.maxWallClockMs < p.timeoutMs))) {
      throw new TraeCliError("authorization");
    }
    if (usedLeases.size >= 100000) throw new TraeCliError("authorization");
    usedLeases.add(lease.leaseId);
  } catch { throw new TraeCliError("authorization"); }
}
export function transportPolicy(extensionSubject: string) {
  return { extensionSubject, executable: "/usr/bin/sandbox-exec", argvPrefix: ["-p"] };
}
export interface PreparedTransport {
  readonly proposal: TransportProposal;
  execute(authorize: AuthorizeTransport, signal?: AbortSignal, onStdout?: (chunk: Buffer) => void): Promise<Buffer>;
}
export interface CliTransport {
  readonly cliPath: string;
  readonly cliDigest: string;
  readonly limits: { timeoutMs: number; maxInputBytes: number; maxOutputBytes: number; maxFrameBytes: number; maxNetworkBytes: number };
  readonly policy: ReturnType<typeof transportPolicy>;
  prepare(purpose: TransportProposal["parameters"]["purpose"], args: readonly string[], stdin?: string): PreparedTransport;
  check(active: boolean): Promise<void>;
}
async function digestExecutable(executable: string): Promise<string> {
  const info = await stat(executable);
  if (!info.isFile() || info.size > 512 * 1024 * 1024 || !(info.mode & 0o111)) throw new TraeCliError("integrity");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(executable)) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new TraeCliError("integrity");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
function freeze<T>(object: T): T {
  if (object !== null && typeof object === "object") {
    for (const value of Object.values(object)) freeze(value);
    Object.freeze(object);
  }
  return object;
}
export async function createTransport(options: TraeCliOptions): Promise<CliTransport> {
  if (process.platform !== "darwin") throw new TraeCliError("unsupported_platform");
  if (!options.cliPath.startsWith("/") || !safeHost(options.endpointHost) ||
      !options.egressHosts.includes(options.endpointHost) || options.egressHosts.length > 16 ||
      options.egressHosts.some((host) => !safeHost(host)) ||
      new Set(options.egressHosts).size !== options.egressHosts.length) throw new TraeCliError("configuration");
  const subject = options.extensionSubject ?? "keystone.trae-cli";
  const nativeAuthFile = options.nativeAuthFile;
  const nativeModelsFile = options.nativeModelsFile;
  for (const [file, basename] of [[nativeAuthFile, "auth.json"], [nativeModelsFile, "models_cache.json"]] as const) {
    if (file === undefined) continue;
    if (!file.endsWith("/" + basename) || !file.startsWith("/") ||
        await realpath(file) !== file || !(await stat(file)).isFile()) {
      throw new TraeCliError("configuration");
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(subject)) throw new TraeCliError("configuration");
  const limits = {
    timeoutMs: options.limits?.timeoutMs ?? 60000, maxInputBytes: options.limits?.maxInputBytes ?? 262144,
    maxOutputBytes: options.limits?.maxOutputBytes ?? 1048576, maxFrameBytes: options.limits?.maxFrameBytes ?? 262144,
    maxNetworkBytes: options.limits?.maxNetworkBytes ?? 8388608,
  };
  const ceilings = { timeoutMs: 120000, maxInputBytes: 1048576, maxOutputBytes: 4194304,
    maxFrameBytes: 1048576, maxNetworkBytes: 33554432 };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ceilings[key]) throw new TraeCliError("configuration");
  }
  if (limits.maxFrameBytes > limits.maxOutputBytes) throw new TraeCliError("configuration");
  const outputSchema = canonical(options.outputSchema ?? OUTPUT_SCHEMA);
  if (Buffer.byteLength(outputSchema) > 262144) throw new TraeCliError("configuration");
  const outputSchemaHash = createHash("sha256").update(outputSchema).digest("hex");
  let cliPath: string, cliDigest: string;
  try {
    cliPath = await realpath(options.cliPath);
    sandboxProfile(cliPath, "/private/tmp/keystone-validation");
    cliDigest = await digestExecutable(cliPath);
    if (await realpath(SANDBOX_EXECUTABLE) !== SANDBOX_EXECUTABLE) throw new TraeCliError("confinement");
    if (await realpath(SYSTEM_CA_BUNDLE) !== SYSTEM_CA_BUNDLE || !(await stat(SYSTEM_CA_BUNDLE)).isFile()) {
      throw new TraeCliError("confinement");
    }
  } catch (error) { throw error instanceof TraeCliError ? error : new TraeCliError("configuration"); }
  const hosts = Object.freeze([...options.egressHosts]);
  const isActive = options.isActive, checkIntegrity = options.checkIntegrity, requestedPath = options.cliPath;
  const check = async (active: boolean) => {
    try {
      if (active && !(await isActive?.())) throw new TraeCliError("inactive");
      if (checkIntegrity && !(await checkIntegrity())) throw new TraeCliError("integrity");
      if (await realpath(requestedPath) !== cliPath || await digestExecutable(cliPath) !== cliDigest) {
        throw new TraeCliError("integrity");
      }
      for (const file of [nativeAuthFile, nativeModelsFile]) {
        if (file && (await realpath(file) !== file || !(await stat(file)).isFile())) throw new TraeCliError("integrity");
      }
    } catch (error) { throw error instanceof TraeCliError ? error : new TraeCliError("integrity"); }
  };
  const transport: CliTransport = {
    cliPath, cliDigest, limits: freeze(limits), policy: freeze(transportPolicy(subject)), check,
    prepare(purpose, args, stdin = "") {
      const input = Buffer.from(stdin);
      if (input.length > limits.maxInputBytes) throw new TraeCliError("input_limit");
      if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new TraeCliError("configuration");
      const root = "/private/tmp/keystone-trae-" + randomUUID();
      const network = purpose === "models" || purpose === "generate";
      const port = network ? randomInt(49152, 65536) : undefined;
      const token = randomBytes(24).toString("base64url");
      const env = isolatedEnvironment(root, port, token);
      const isolatedExecutable = root + "/traex";
      const profile = sandboxProfile(isolatedExecutable, root, port,
        network ? nativeAuthFile : undefined, network ? nativeModelsFile : undefined);
      // Discovery and exec are non-interactive. 0.210.1 rejects --no-daemon there;
      // Unix/Mach IPC is denied by Seatbelt regardless of CLI daemon preferences.
      const cliArgs = [...(network ? [] : ["--no-daemon"]), ...args,
        ...(purpose === "generate" ? ["--output-schema", root + "/output-schema.json", "-"] : [])];
      const parameters = freeze({
        command: SANDBOX_EXECUTABLE, args: ["-p", profile, isolatedExecutable, ...cliArgs],
        cwd: root + "/work", temporaryRoot: root,
        stdinHash: createHash("sha256").update(input).digest("hex"), stdinBytes: input.length,
        environmentHash: parametersHash(env), cliDigest, sourceExecutable: cliPath, purpose, timeoutMs: limits.timeoutMs,
        ...(purpose === "generate" ? { outputSchemaHash } : {}),
        maxOutputBytes: limits.maxOutputBytes, maxNetworkBytes: network ? limits.maxNetworkBytes : 0,
        egressHosts: network ? hosts : [],
        allowPrivateNetwork: options.allowPrivateNetwork === true,
        ...(network && nativeAuthFile ? { nativeAuthFile } : {}),
        ...(network && nativeModelsFile ? { nativeModelsFile } : {}),
      });
      const proposal: TransportProposal = freeze({
        subject: { kind: "extension", id: subject }, capability: "cmd.exec",
        resource: { kind: "command", values: [SANDBOX_EXECUTABLE], mode: "execute" },
        parameters, parametersHash: parametersHash(parameters),
      });
      let attempted = false;
      return {
        proposal,
        async execute(authorize, signal, onStdout) {
          if (attempted) throw new TraeCliError("authorization");
          attempted = true;
          requireLive(signal);
          await cancelAware(() => check(purpose === "generate"), signal);
          let lease: TransportLease;
          try { lease = await cancelAware(() => authorize(proposal), signal); }
          catch { requireLive(signal); throw new TraeCliError("authorization"); }
          requireLive(signal);
          consumeLease(proposal, lease);
          const started = Date.now();
          const deadline = Math.min(started + parameters.timeoutMs, Date.parse(lease.expiresAt));
          let owned = false;
          let gateway: Gateway | undefined;
          const confinementAbort = new AbortController();
          const processSignal = signal ? AbortSignal.any([signal, confinementAbort.signal]) : confinementAbort.signal;
          try {
            await cancelAware(() => check(purpose === "generate"), processSignal);
            if (signal?.aborted) throw new TraeCliError("cancelled");
            await mkdir(root, { mode: 0o700 }); owned = true;
            await mkdir(parameters.cwd, { mode: 0o700 });
            await mkdir(root + "/home", { mode: 0o700 });
            await mkdir(root + "/tmp", { mode: 0o700 });
            await mkdir(root + "/home/.trae", { mode: 0o700 });
            if (nativeAuthFile && network) {
              // Native CLI reads its login in place through an owned symlink;
              // its app-server/cache writes remain in scratch, never the source home.
              await symlink(nativeAuthFile, root + "/home/.trae/auth.json");
            }
            if (nativeModelsFile && network) {
              await symlink(nativeModelsFile, root + "/home/.trae/models_cache.json");
            }
            await copyFile(cliPath, isolatedExecutable, constants.COPYFILE_EXCL);
            await chmod(isolatedExecutable, 0o500);
            if (await digestExecutable(isolatedExecutable) !== cliDigest) throw new TraeCliError("integrity");
            if (purpose === "generate") {
              await writeFile(root + "/output-schema.json", outputSchema, { mode: 0o600, flag: "wx" });
            }
            if (port !== undefined) gateway = await startGateway({
              port, hosts, authToken: token, maxBytes: limits.maxNetworkBytes,
              allowPrivateNetwork: options.allowPrivateNetwork === true,
              timeoutMs: Math.max(1, deadline - Date.now()), signal: processSignal,
              onFailure: () => confinementAbort.abort(),
            });
            await cancelAware(() => check(purpose === "generate"), processSignal);
            if (Date.now() >= deadline) throw new TraeCliError("timeout");
            const result = await runBounded({
              executable: parameters.command, args: parameters.args, cwd: parameters.cwd, env, stdin: input,
              timeoutMs: deadline - Date.now(), maxOutputBytes: parameters.maxOutputBytes,
              signal: processSignal, ...(onStdout ? { onStdout } : {}),
            });
            gateway?.assertSafe();
            return result.stdout;
          } catch (error) {
            gateway?.assertSafe();
            throw error instanceof TraeCliError ? error : new TraeCliError("confinement");
          } finally {
            await gateway?.close();
            if (owned) await rm(root, { recursive: true, force: true });
          }
        },
      };
    },
  };
  return transport;
}

export async function executeTransport(transport: CliTransport,
  purpose: TransportProposal["parameters"]["purpose"], args: readonly string[], stdin: string,
  authorize: AuthorizeTransport, signal?: AbortSignal, onStdout?: (chunk: Buffer) => void): Promise<Buffer> {
  const lifetime = AbortSignal.timeout(transport.limits.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
  for (let attempt = 0; attempt < 3; attempt++) {
    requireLive(signal);
    if (lifetime.aborted) throw new TraeCliError("timeout");
    const prepared = transport.prepare(purpose, args, stdin);
    try {
      return await prepared.execute(authorize, combined, onStdout);
    } catch (error) {
      if (lifetime.aborted && !signal?.aborted) throw new TraeCliError("timeout");
      if (!(error instanceof GatewayPortInUseError) || attempt === 2) throw error;
    }
  }
  throw new TraeCliError("confinement");
}
