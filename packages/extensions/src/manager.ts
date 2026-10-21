/**
 * End-user governed extension install: the local-path entry point.
 *
 * The kernel owns every state transition; this module only turns a local
 * package directory into the facts the existing registry and Conformance Kit
 * already know how to act on:
 *
 *  - read the manifest the package ships,
 *  - verify its declared digest against the bytes that would actually run,
 *  - review without execution, then probe a copy only after explicit consent,
 *  - hand the result to the registry, which is the only writer.
 *
 * There is no remote fetch here: installation is local-path first by design, so
 * the user can see exactly which directory they are trusting (PRD PL-01, PL-02).
 */

import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveSpawnTarget } from "@keystone/spawn";
import { sanitizeEnv } from "@keystone/tools";

import {
  extensionManifestSchema,
  canonicalJson,
  sha256Bytes,
  sha256Hex,
  userDecisionSchema,
  type ConformanceReport,
  type ExtensionManifest,
  type ExtensionRegistration,
  type UserDecision,
} from "@keystone/schemas";

import { canActivate, reachesOutside, type ActivationGateResult } from "./activation.ts";
import { runConformance, type ConformanceProbe } from "./conformance.ts";
import { describeInstallReview, type InstallReview } from "./manifest.ts";
import { isolatedVerifierEntryShapeProbe, probeEnvironment, probeLimits, type IsolatedProbeLimits } from "./verifier-entry-probe.ts";
import { decodeLine, encodeFrame } from "./mcp/protocol.ts";
import { checkSkillConformance, inspectSkill } from "./skills/loader.ts";

/** The manifest file every local package must ship at its root. */
export const EXTENSION_MANIFEST_FILE = "keystone-extension.json";

/** Where the persistent registry lives under a Keystone home. */
export function defaultRegistryLocation(home: string): { readonly registryFile: string } {
  return { registryFile: join(home, "extensions", "registry.json") };
}

export class LocalPackageError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "LocalPackageError";
    this.issues = issues;
  }
}

export interface ReadLocalPackage {
  readonly manifest: ExtensionManifest;
  readonly integrityBasis: "entry_digest" | "local_path_trust";
  /** Digest match, or explicitly approved local-path trust after consent. */
  readonly integrityVerified: boolean;
  /** Absolute path of the in-process entry module, when the package has one. */
  readonly entryPath?: string;
  readonly review: InstallReview;
}

interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

interface PackageSnapshot {
  readonly root: string;
  readonly files: readonly PackageFile[];
}

function confinedPath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new LocalPackageError(`package path escapes the local package: ${path}`);
  }
  return target;
}

/** Bounded source inventory. No symlinks, device files, hidden data or dependencies. */
async function snapshotPackage(packageRoot: string): Promise<PackageSnapshot> {
  const root = await realpath(resolve(packageRoot));
  const files: PackageFile[] = [];
  let bytes = 0;
  let visited = 0;
  async function visit(dir: string, depth = 0): Promise<void> {
    if (depth > 32) throw new LocalPackageError("package exceeds the static review directory depth limit");
    for (const name of (await readdir(dir)).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (++visited > 512) throw new LocalPackageError("package exceeds the 512-entry static review limit");
      const path = join(dir, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new LocalPackageError(`package symlinks are not reviewable: ${relative(root, path)}`);
      if (stat.isDirectory()) {
        await visit(path, depth + 1);
      } else {
        if (!stat.isFile()) throw new LocalPackageError("package contains a non-regular file");
        if (bytes + stat.size > 16 * 1024 * 1024) throw new LocalPackageError("package exceeds the 16MiB static review limit");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content: Uint8Array;
        try {
          const current = await handle.stat();
          if (!current.isFile()) throw new LocalPackageError("reviewed file is no longer regular");
          const buffer = Buffer.alloc(16 * 1024 * 1024 - bytes + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (bytesRead === 0) break;
            size += bytesRead;
          }
          content = buffer.subarray(0, size);
        } finally { await handle.close(); }
        bytes += content.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new LocalPackageError("package exceeds the 16MiB static review limit");
        files.push({ path: relative(root, path), bytes: content, mode: stat.mode });
      }
    }
  }
  await visit(root);
  return { root, files };
}

function readSnapshot(snapshot: PackageSnapshot): ReadLocalPackage {
  const { root } = snapshot;
  const manifestPath = join(root, EXTENSION_MANIFEST_FILE);
  const manifestFile = snapshot.files.find((file) => file.path === EXTENSION_MANIFEST_FILE);
  if (manifestFile === undefined) {
    throw new LocalPackageError(
      `no ${EXTENSION_MANIFEST_FILE} found in ${root}; a local extension must ship its manifest`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
  } catch (error) {
    throw new LocalPackageError(
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let manifest: ExtensionManifest;
  try {
    manifest = extensionManifestSchema.parse(parsed) as ExtensionManifest;
  } catch (error) {
    throw new LocalPackageError(
      `${manifestPath} does not match the extension manifest schema`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  // An out-of-process stdio server ships no bundled TS bytes to digest. The
  // local directory the user pointed at is the trust anchor (ADR-0009); that
  // the declared command actually resolves is proven by a conformance probe,
  // not by hashing. This is a stated, weaker boundary than digesting bundled
  // entry bytes — it is not papered over.
  if (manifest.transport !== undefined) {
    confinedPath(root, manifest.transport.cwd ?? ".");
    return {
      manifest,
      integrityVerified: false,
      integrityBasis: "local_path_trust",
      review: describeInstallReview(manifest),
    };
  }

  if (manifest.entry === undefined) {
    if (manifest.kind === "skill") {
      const skill = snapshot.files.find((file) => file.path === "SKILL.md");
      if (skill === undefined) throw new LocalPackageError("a Skill package must include SKILL.md");
      return {
        manifest, integrityBasis: "entry_digest",
        integrityVerified: sha256Bytes(skill.bytes) === manifest.integrity.digest,
        review: describeInstallReview(manifest),
      };
    }
    throw new LocalPackageError(
      `a ${manifest.kind} extension must declare either an in-process entry (entry.module) or a stdio transport`,
    );
  }

  const entryPath = confinedPath(root, manifest.entry.module);
  const entryFile = snapshot.files.find((file) => file.path === relative(root, entryPath));
  if (entryFile === undefined) {
    throw new LocalPackageError(
      `the manifest declares entry "${manifest.entry.module}", which cannot be read from ${root}`,
    );
  }

  const integrityVerified = sha256Bytes(entryFile.bytes) === manifest.integrity.digest;

  return {
    manifest,
    integrityVerified,
    integrityBasis: "entry_digest",
    entryPath,
    review: describeInstallReview(manifest),
  };
}

/** Static only. An entry digest does not cover dependencies or prove publisher trust. */
export async function readLocalPackage(packageRoot: string): Promise<ReadLocalPackage> {
  return readSnapshot(await snapshotPackage(packageRoot));
}

/**
 * Kept as a fail-closed compatibility hook. Local package imports must use the
 * approved child probe, not return executable objects to the trusted host.
 */
export function localEntryLoader(
  packageRoot: string,
): (modulePath: string, exportName: string) => Promise<unknown> {
  return async () => {
    throw new LocalPackageError(`host entry loading is disabled for ${resolve(packageRoot)}; use probeLocalInstall`);
  };
}

export interface PreparedLocalInstall {
  readonly phase: "static" | "probed";
  readonly reviewHash: string;
  readonly staticChecksPassed: boolean;
  readonly files: readonly { readonly path: string; readonly digest: string; readonly bytes: number; readonly mode: number }[];
  readonly read: ReadLocalPackage;
  readonly conformance: ConformanceReport;
  readonly gate: ActivationGateResult;
}

/**
 * Static review only: no import, process launch, or behavioral probe. The
 * pending consent check prevents this report from being used for activation.
 */
export async function prepareLocalInstall(packageRoot: string): Promise<PreparedLocalInstall> {
  return prepareSnapshot(await snapshotPackage(packageRoot));
}

async function prepareSnapshot(snapshot: PackageSnapshot): Promise<PreparedLocalInstall> {
  const read = readSnapshot(snapshot);
  const conformance = await runConformance({
    manifest: read.manifest,
    integrityVerified: read.integrityVerified,
    integrityBasis: read.integrityBasis,
    staticOnly: true,
  });
  const gate = canActivate({
    manifest: read.manifest,
    integrityVerified: read.integrityVerified,
    conformance,
  });
  const files = snapshot.files.map((file) => ({
    path: file.path, digest: sha256Bytes(file.bytes), bytes: file.bytes.byteLength, mode: file.mode & 0o777,
  }));
  const reviewHash = sha256Hex(canonicalJson({ root: snapshot.root, manifest: read.manifest, files }));
  const staticChecksPassed = conformance.checks.every((c) =>
    c.checkId === "execution.consent" ||
    (c.checkId === "manifest.integrity" && read.integrityBasis === "local_path_trust") ||
    c.passed || !c.blocking);
  return { read, conformance, gate, phase: "static", reviewHash, staticChecksPassed, files };
}

export interface LocalProbeApproval extends IsolatedProbeLimits {
  readonly decision: UserDecision;
  /** Binds consent to the package and declaration that were actually reviewed. */
  readonly reviewHash: string;
}

function requireLiveApproval(decision: UserDecision): void {
  if (decision.recordedBy !== "user" || decision.decision !== "allow" ||
      (decision.appliesTo.expiresAt !== undefined &&
       Date.parse(decision.appliesTo.expiresAt) <= Date.now())) {
    throw new LocalPackageError("bounded probes require a live explicit user approval");
  }
}

/** No registration, capability grant, runtime activation, or host import. */
export async function probeLocalInstall(
  packageRoot: string,
  approval: LocalProbeApproval,
): Promise<PreparedLocalInstall> {
  const decision = userDecisionSchema.parse(approval.decision) as UserDecision;
  requireLiveApproval(decision);
  approval.signal?.throwIfAborted();
  const limits = probeLimits(approval);
  return withReviewedPackage(packageRoot, approval.reviewHash, async (workspace, prepared) => {
    const entry = prepared.read.manifest.entry;
    const read = prepared.read.integrityBasis === "local_path_trust"
      ? { ...prepared.read, integrityVerified: true } : prepared.read;
    const probes: ConformanceProbe[] = [];
    if (read.manifest.transport !== undefined) {
      probes.push(isolatedMcpProbe(read.manifest, [await realpath(resolve(packageRoot)), resolve(packageRoot)],
        workspace, { ...limits, signal: approval.signal }));
    } else if (read.manifest.kind === "verifier" && entry !== undefined) {
      probes.push(isolatedVerifierEntryShapeProbe({ workspace, entry, ...limits, signal: approval.signal }));
    } else if (read.manifest.kind === "skill") {
      const skill = await inspectSkill(workspace);
      if (skill === undefined) throw new LocalPackageError("Skill frontmatter is invalid");
      for (const check of checkSkillConformance(skill)) {
        probes.push({ ...check, blocking: true, run: async () => check });
      }
    }
    requireLiveApproval(decision);
    approval.signal?.throwIfAborted();
    const conformance = await runConformance({
      manifest: read.manifest, integrityVerified: read.integrityVerified,
      integrityBasis: read.integrityBasis, probes,
    });
    approval.signal?.throwIfAborted();
    return {
      ...prepared, read, phase: "probed", conformance,
      gate: canActivate({ manifest: read.manifest, integrityVerified: read.integrityVerified, conformance, decision }),
    };
  }, approval.signal);
}

/** Trusted host callback receives immutable reviewed bytes in a disposable copy. */
export async function withReviewedPackage<T>(packageRoot: string, reviewHash: string,
  use: (workspace: string, prepared: PreparedLocalInstall) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const snapshot = await snapshotPackage(packageRoot);
  const prepared = await prepareSnapshot(snapshot);
  if (prepared.reviewHash !== reviewHash) {
    throw new LocalPackageError("package changed since static review; review and approve it again");
  }
  if (!prepared.staticChecksPassed) {
    throw new LocalPackageError("static checks failed; no behavioral probe was launched");
  }
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "keystone-extension-probe-")));
  try {
    // Write the reviewed bytes, not a second live filesystem read after consent.
    for (const file of snapshot.files) {
      const target = join(workspace, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { mode: file.mode & 0o777 });
    }
    // Only host-owned lower-layer packages are linked, never package-supplied
    // node_modules or install scripts. Workspace symlinks retain native TS.
    const dependencies = join(workspace, "node_modules", "@keystone");
    await mkdir(dependencies, { recursive: true });
    const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    for (const name of ["schemas", "kernel", "verifiers", "spawn"]) {
      await symlink(join(packages, name), join(dependencies, name), "dir");
    }
    signal?.throwIfAborted();
    return await use(workspace, prepared);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** The two-request probe never calls an advertised tool or launches a host loader. */
function isolatedMcpProbe(
  manifest: ExtensionManifest,
  packageRoots: readonly string[],
  workspace: string,
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal },
): ConformanceProbe {
  return {
    checkId: "mcp.handshake",
    blocking: true,
    detail: "bounded initialize/tools-list in a copied temporary workspace",
    async run() {
      limits.signal?.throwIfAborted();
      const transport = manifest.transport!;
      const cwd = confinedPath(workspace, transport.cwd ?? ".");
      const relocate = (arg: string) => {
        if (!isAbsolute(arg)) return arg;
        for (const root of packageRoots) {
          const rel = relative(root, arg);
          if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
            return resolve(workspace, rel);
          }
        }
        throw new LocalPackageError("probe arguments may not reference paths outside the reviewed package");
      };
      let args: string[];
      try { args = transport.args.map(relocate); }
      catch { return { passed: false, detail: "MCP probe arguments escape the reviewed package" }; }
      let command = transport.command;
      if (isAbsolute(command)) {
        // Package-owned executables run from the same reviewed copy as scripts.
        // External system commands retain the explicitly approved path trust.
        for (const root of packageRoots) {
          const rel = relative(root, command);
          if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
            command = resolve(workspace, rel);
            break;
          }
        }
      } else if (command.startsWith(".") || command.includes(sep)) {
        command = confinedPath(workspace, command);
      }
      const target = resolveSpawnTarget(command, args);
      const nodeCommand = target.command === process.execPath || target.command === "node";
      if (nodeCommand) {
        if (args.some((arg) => /^--(?:allow-|no-.*permission|experimental-loader|import|require)/.test(arg) || arg === "-r")) {
          return { passed: false, detail: "MCP probe cannot widen Node permissions or preload host code" };
        }
        args = [
          "--experimental-permission",
          `--allow-fs-read=${workspace}`,
          `--allow-fs-write=${workspace}`,
          ...args,
        ];
      }
      const declaredEnv = sanitizeEnv({}, transport.env);
      for (const key of Object.keys(declaredEnv)) {
        if (/^(?:NODE_|LD_|DYLD_|PYTHON|PERL|RUBY|BASH_FUNC_)/i.test(key) ||
            /^(?:PATH|HOME|PWD|TMPDIR|TEMP|TMP|USERPROFILE|SYSTEMROOT|COMSPEC|PATHEXT|SHELL|BASH_ENV|ENV|CDPATH)$/i.test(key)) {
          delete declaredEnv[key];
        }
      }
      return await new Promise<{ passed: boolean; detail: string }>((complete) => {
        const child = spawn(target.command, nodeCommand ? args : [...target.args], {
          cwd, env: { ...declaredEnv, ...probeEnvironment(workspace) }, shell: false,
          detached: process.platform !== "win32",
          windowsVerbatimArguments: target.windowsVerbatimArguments,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let bytes = 0;
        let buffer = "";
        let initialized = false;
        let serverName = "";
        let outcome: { passed: boolean; detail: string } | undefined;
        const kill = () => {
          if (child.pid === undefined) return;
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { child.kill("SIGKILL"); }
        };
        const finish = (passed: boolean, detail: string) => {
          outcome ??= { passed, detail };
          kill();
        };
        const timer = setTimeout(() => finish(false, "MCP probe timed out"), limits.timeoutMs);
        const onAbort = () => finish(false, "MCP probe cancelled");
        limits.signal?.addEventListener("abort", onAbort, { once: true });
        if (limits.signal?.aborted) onAbort();
        const account = (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > limits.maxOutputBytes) finish(false, "MCP probe exceeded its output limit");
        };
        child.stderr.setEncoding("utf8").on("data", account);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          account(chunk);
          if (outcome !== undefined) return;
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1 && outcome === undefined) {
            const frame = decodeLine(buffer.slice(0, newline)).value;
            buffer = buffer.slice(newline + 1);
            if (frame === undefined || frame.id !== (initialized ? 2 : 1)) continue;
            if (frame.error !== undefined || typeof frame.result !== "object" || frame.result === null) {
              finish(false, "MCP probe received an invalid or rejected response");
              break;
            }
            const result = frame.result as Record<string, unknown>;
            if (!initialized) {
              const info = result.serverInfo as Record<string, unknown> | undefined;
              if (result.protocolVersion !== "2024-11-05" || typeof info?.name !== "string" ||
                  typeof info.version !== "string") {
                finish(false, "MCP initialize response is malformed or incompatible");
                break;
              }
              serverName = info.name.slice(0, 256);
              initialized = true;
              child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
              child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
            } else if (Array.isArray(result.tools) &&
                       result.tools.every((tool) => typeof tool === "object" && tool !== null && typeof tool.name === "string")) {
              const names = result.tools.map((tool: { name: string }) => tool.name.slice(0, 80)).slice(0, 10);
              finish(true, `handshake ok with ${serverName}; discovered ${result.tools.length} tool(s): ${names.join(", ") || "(none)"}`);
            } else finish(false, "MCP tools/list response is malformed");
          }
        });
        child.stdin.on("error", () => finish(false, "MCP probe input closed"));
        child.on("error", () => finish(false, "could not launch MCP probe"));
        child.once("close", () => {
          clearTimeout(timer);
          limits.signal?.removeEventListener("abort", onAbort);
          kill();
          complete(outcome ?? { passed: false, detail: "MCP probe exited before conformance completed" });
        });
        child.stdin.write(encodeFrame({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "keystone-probe", version: "1.0" } },
        }));
      });
    },
  };
}

export interface LowRiskExtensionView {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  /** Compatibility alias for registryStatus, not a running-runtime observation. */
  readonly status: string;
  readonly registryStatus: string;
  readonly runtimeActivation: "not_observed";
}

/**
 * Read-only projection of active extensions a shell may show.
 *
 * Only low-risk active extensions are surfaced: local, verified, and unable to
 * reach outside the machine. This is visibility, not a grant — listing an
 * extension never widens what it may do, and the kernel still issues every
 * lease against the user's envelope (PRD 9.7, PL-02).
 */
export function lowRiskActiveExtensions(
  entries: readonly ExtensionRegistration[],
): readonly LowRiskExtensionView[] {
  return entries
    .filter(
      (entry) =>
        entry.status === "active" && entry.integrityVerified && !reachesOutside(entry.manifest),
    )
    .map((entry) => ({
      name: entry.manifest.name,
      version: entry.manifest.version,
      publisher: entry.manifest.publisher,
      kind: entry.manifest.kind,
      capabilities: [...entry.manifest.capabilities],
      status: entry.status,
      registryStatus: entry.status,
      runtimeActivation: "not_observed",
    }));
}
