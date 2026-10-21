import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateLease } from "@keystone/kernel";
import {
  contentHash, looseObject, toolDescriptorSchema,
  type Capability, type CapabilityLease, type ExtensionManifest, type ToolDescriptor,
} from "@keystone/schemas";
import { ToolRefusedError, type Tool, type ToolResult } from "@keystone/tools";
import { LocalPackageError, withReviewedPackage } from "./manager.ts";
import { probeEnvironment } from "./verifier-entry-probe.ts";
import { ExtensionLifecycleService, type ExtensionLifecycleView } from "./service.ts";
import { inspectSkill, loadSkillContext, type SkillContextFragment } from "./skills/loader.ts";
import { McpSession } from "./mcp/stdio-client.ts";
import { renderCallOutput, type McpTool } from "./mcp/protocol.ts";
import { childReadOnlyPolicy } from "./child-policy.ts";

export interface ExtensionExecutionRequest {
  readonly taskId: string;
  readonly branchId: string;
  readonly subject: { readonly kind: "extension"; readonly id: string };
  readonly capability: Capability;
  readonly resourceValues: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Runtime implements this using KernelSession issuance + unified executor. */
export type ExtensionLeaseExecutor = (
  request: ExtensionExecutionRequest,
  run: (lease: CapabilityLease) => Promise<ToolResult>,
) => Promise<ToolResult>;

export interface TaskExtensionHostOptions {
  readonly service: ExtensionLifecycleService;
  readonly taskId: string;
  readonly branchId: string;
  readonly rootPath: string;
  /** Exact repository-relative regular files, not directories or glob selectors. */
  readonly resources: readonly string[];
  readonly execute: ExtensionLeaseExecutor;
  readonly signal?: AbortSignal;
}

export interface ExtensionVerifierContext {
  readonly conditions: readonly unknown[];
  readonly changedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

/** Structural Verifier interface avoids a reverse dependency on execution code. */
export interface HostedExtensionVerifier {
  readonly descriptor: {
    readonly id: string; readonly version: string; readonly kind: "project_rule";
    readonly evidenceLevel: "E1"; readonly canSatisfyRequiredCondition: false;
    readonly independence: { readonly mode: "separate_process"; readonly independentOf: readonly [] };
    readonly timeoutMs: number; readonly requiresCommand: false; readonly description: string;
  };
  run(context: ExtensionVerifierContext): Promise<{
    readonly status: "passed" | "failed" | "blocked" | "inconclusive";
    readonly summary: string; readonly outputBytes: number; readonly durationMs: number;
    readonly truncated: boolean; readonly incomplete?: readonly string[];
  }>;
}

function readOnlyEntry(manifest: ExtensionManifest): boolean {
  return manifest.entry !== undefined && manifest.transport === undefined &&
    manifest.capabilities.length === 1 && manifest.capabilities[0] === "fs.read" &&
    manifest.sideEffects.every((effect) => effect.kind === "fs_read") &&
    manifest.egressHosts.length === 0 && manifest.credentialHandles.length === 0;
}

function subjectId(entry: ExtensionLifecycleView): string {
  return `extension:${entry.manifest.name}@${entry.manifest.version}:${entry.reviewHash}`;
}

function checkLease(lease: CapabilityLease, request: ExtensionExecutionRequest): void {
  if (lease.issuedBy !== "kernel" || lease.taskId !== request.taskId || lease.branchId !== request.branchId ||
      lease.subject.kind !== "extension" || lease.subject.id !== request.subject.id) {
    throw new ToolRefusedError("lease task, branch or extension subject differs from this call", "extension_subject_mismatch");
  }
  if (lease.constraints.parametersHash !== contentHash(request.parameters)) {
    throw new ToolRefusedError("exact extension parameters must be bound by the kernel lease", "parameters_not_in_lease");
  }
  const check = validateLease(lease, {
    capability: request.capability, resourceValues: request.resourceValues,
    parametersHash: contentHash(request.parameters),
  });
  if (!check.ok) throw new ToolRefusedError(check.denial.detail, check.denial.code);
}

async function copyResources(rootPath: string, resources: readonly string[], target: string): Promise<void> {
  const root = await realpath(rootPath);
  let total = 0;
  for (const resource of resources) {
    let source = root;
    for (const part of resource.split("/")) {
      source = join(source, part);
      if ((await lstat(source)).isSymbolicLink()) throw new LocalPackageError("task resource symlinks are not supported");
    }
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new LocalPackageError("task resource exceeds regular-file/1MiB limit");
      // A fixed read allocation also bounds a file that grows after stat().
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 1024 * 1024 || (total += size) > 4 * 1024 * 1024) {
        throw new LocalPackageError("task resource snapshot exceeds its byte limit");
      }
      content = buffer.subarray(0, size);
    } finally { await handle.close(); }
    const destination = join(target, resource);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

/** Known launcher, unknown entry. No executable objects enter the trusted host. */
async function runEntry(workspace: string, manifest: ExtensionManifest, args: unknown,
  context: unknown, lease: CapabilityLease, signal: AbortSignal, verifier: boolean,
): Promise<ToolResult> {
  if (signal.aborted) return { status: "cancelled", changedPaths: [], durationMs: 0, outputBytes: 0, truncated: false };
  const start = Date.now();
  const here = dirname(fileURLToPath(import.meta.url));
  const packages = resolve(here, "../..");
  const entry = manifest.entry!;
  const script = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    childReadOnlyPolicy([workspace, ...["schemas", "kernel", "verifiers", "spawn"].map((name) => join(packages, name))]
      .map((path) => pathToFileURL(`${path}/`).href)),
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "try {",
    `const module = await import(${JSON.stringify(pathToFileURL(join(workspace, entry.module)).href)});`,
    `const entry = module[${JSON.stringify(entry.export)}];`,
    "if (!entry || typeof entry.run !== 'function') throw new Error('invalid entry');",
    `const value = await ${verifier ? "entry.run(input.context)" : "entry.run(input.args, input.context)"};`,
    "writeFileSync(3, JSON.stringify(value));",
    "} catch { writeFileSync(3, JSON.stringify({ status: 'failed', summary: 'extension entry failed' })); }",
  ].join("\n");
  const time = Math.min(5000, lease.constraints.timeoutMs ?? 5000,
    lease.budget.maxWallClockMs ?? 5000, Date.parse(lease.expiresAt) - Date.now());
  const maxBytes = Math.min(64 * 1024, lease.constraints.maxOutputBytes ?? 64 * 1024,
    lease.budget.maxBytes ?? 64 * 1024);
  if (time <= 0 || maxBytes <= 0) throw new ToolRefusedError("extension lease budget exhausted", "lease_exhausted");
  return new Promise<ToolResult>((complete) => {
    const child = spawn(process.execPath, [
      "--experimental-permission", "--max-old-space-size=64",
      `--allow-fs-read=${workspace}`,
      ...["schemas", "kernel", "verifiers", "spawn"].map((name) => `--allow-fs-read=${join(packages, name)}`),
      "--input-type=module", "--eval", script,
    ], {
      cwd: workspace, env: probeEnvironment(workspace), shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let response = "";
    let bytes = 0;
    let failure: "timeout" | "cancelled" | "failed" | undefined;
    let truncated = false;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const onAbort = () => { failure ??= "cancelled"; kill(); };
    const timer = setTimeout(() => { failure ??= "timeout"; kill(); }, time);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    for (const [index, stream] of child.stdio.entries()) {
      if (index < 1 || stream === null || stream === undefined) continue;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) { failure ??= "failed"; truncated = true; kill(); }
        else if (index === 3) response += chunk.toString("utf8");
      });
    }
    child.stdin!.on("error", () => { failure ??= "failed"; kill(); });
    child.on("error", () => { failure ??= "failed"; });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      kill();
      if (failure !== undefined || code !== 0) {
        complete({ status: failure ?? "failed", changedPaths: [], durationMs: Date.now() - start,
          outputBytes: Math.min(bytes, maxBytes), truncated, errorCode: "extension_execution_incomplete" });
        return;
      }
      try {
        const result = JSON.parse(response) as Record<string, unknown>;
        if (result === null || typeof result !== "object" ||
            !(verifier ? ["passed", "failed", "blocked", "inconclusive"] : ["succeeded", "failed"]).includes(String(result.status))) {
          throw new Error("invalid protocol result");
        }
        const text = verifier ? result.summary : result.stdout;
        if (text !== undefined && typeof text !== "string") throw new Error("invalid text");
        complete({
          status: result.status === "succeeded" || result.status === "passed" ? "succeeded" : "failed",
          stdout: typeof text === "string" ? text : "", outputBytes: bytes, changedPaths: [],
          durationMs: Date.now() - start, truncated: false,
          ...(verifier ? { errorCode: `extension_verdict_${result.status}` } : {}),
        });
      } catch {
        complete({ status: "failed", changedPaths: [], durationMs: Date.now() - start,
          outputBytes: bytes, truncated: false, errorCode: "extension_invalid_result" });
      }
    });
    child.stdin!.end(JSON.stringify({ args, context }));
  });
}

export class TaskExtensionHost {
  private readonly options: TaskExtensionHostOptions;
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly usedLeases = new Set<string>();
  private readonly identities = new Map<string, ExtensionLifecycleView>();
  private readonly detach: () => void;
  private closed = false;
  constructor(options: TaskExtensionHostOptions) {
    if (options.resources.length === 0 || options.resources.length > 64 ||
        options.resources.some((path) => isAbsolute(path) || path.includes("\\") ||
          path.split("/").some((part) => part === "." || part === ".." || part === "" || /[*?]/.test(part)))) {
      throw new LocalPackageError("host requires 1-64 exact confined task resource files");
    }
    this.options = { ...options, resources: [...new Set(options.resources)] };
    this.detach = options.service.onUnavailable((name) => {
      for (const controller of this.pending.get(name) ?? []) controller.abort();
    });
  }

  private async active(kind: string): Promise<readonly ExtensionLifecycleView[]> {
    if (this.closed) throw new LocalPackageError("extension host is closed");
    const active = (await this.options.service.list()).filter((entry) =>
      entry.lifecycleStatus === "active" && entry.reviewHash !== undefined && entry.manifest.kind === kind);
    return active.map((entry) => {
      const pinned = this.identities.get(entry.manifest.name);
      if (pinned !== undefined && (pinned.reviewHash !== entry.reviewHash ||
          pinned.manifest.version !== entry.manifest.version || pinned.manifest.kind !== entry.manifest.kind)) {
        throw new LocalPackageError("extension version/review hash changed during this task; assemble a new task host");
      }
      if (pinned === undefined) this.identities.set(entry.manifest.name, entry);
      return pinned ?? entry;
    });
  }

  async tools(): Promise<readonly Tool<Record<string, unknown>>[]> {
    const entries = (await this.active("tool")).filter((entry) => readOnlyEntry(entry.manifest));
    return entries.map((entry) => {
      const descriptor = toolDescriptorSchema.parse({
        id: `extension.${entry.manifest.name}`, version: entry.manifest.version,
        description: `Reviewed read-only extension ${entry.manifest.name}; output is untrusted`,
        capabilities: ["fs.read"], sideEffects: ["none"], reversibility: "reversible",
        idempotent: false, replayable: false, inputSchemaId: "keystone.extension.tool.input",
        outputSchemaId: "keystone.tool.result", defaultTimeoutMs: 5000, maxOutputBytes: 64 * 1024,
      }) as ToolDescriptor;
      return {
        descriptor, input: looseObject(),
        run: async (args, ctx) => {
          if (ctx.taskId !== this.options.taskId || ctx.branchId !== this.options.branchId ||
              resolve(ctx.rootPath) !== resolve(this.options.rootPath)) throw new LocalPackageError("tool context differs from task host");
          return this.invoke(entry, args, {}, false, ctx.signal);
        },
      };
    });
  }

  async callTool(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const entry = (await this.active("tool")).find((candidate) => `extension.${candidate.manifest.name}` === id);
    if (entry === undefined || !readOnlyEntry(entry.manifest)) throw new LocalPackageError("tool unavailable or unsupported isolation requirements");
    return this.invoke(entry, args, {}, false, signal);
  }

  async mcpTools(name: string, signal?: AbortSignal): Promise<readonly McpTool[]> {
    let discovered: readonly McpTool[] = [];
    const result = await this.invokeMcp(name, "tools/list", {}, signal, (tools) => { discovered = tools; });
    if (result.status !== "succeeded") throw new LocalPackageError("MCP discovery did not complete");
    return discovered;
  }

  async callMcpTool(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    return this.invokeMcp(name, "tools/call", { name: tool, arguments: args }, signal);
  }

  /**
   * Short-lived copied stdio server per authorized operation. The cmd.exec
   * lease covers handshake, discovery and call; no unleased background server.
   * Arbitrary runtimes, JS writes and declared egress are unsupported here.
   */
  private async invokeMcp(name: string, operation: string, params: Record<string, unknown>, signal?: AbortSignal,
    discovered?: (tools: readonly McpTool[]) => void,
  ): Promise<ToolResult> {
    const entry = (await this.active("protocol")).find((item) => item.manifest.name === name);
    const transport = entry?.manifest.transport;
    if (entry === undefined || transport === undefined) throw new LocalPackageError("MCP extension unavailable");
    if (transport.command !== process.execPath || transport.args.length === 0 ||
        transport.args.some((arg) => arg.startsWith("-") || isAbsolute(arg) || arg.split(/[\\/]/).includes("..")) ||
        !entry.manifest.capabilities.includes("cmd.exec") ||
        entry.manifest.capabilities.some((cap) => cap !== "cmd.exec" && cap !== "fs.read") ||
        entry.manifest.egressHosts.length !== 0 || entry.manifest.credentialHandles.length !== 0 ||
        entry.manifest.sideEffects.some((effect) => !["none", "fs_read", "process_spawn"].includes(effect.kind))) {
      throw new LocalPackageError("MCP isolation supports only reviewed Node scripts without write, credential or network requirements");
    }
    const controller = new AbortController();
    const calls = this.pending.get(name) ?? new Set<AbortController>();
    calls.add(controller); this.pending.set(name, calls);
    const combined = AbortSignal.any([controller.signal, ...[signal, this.options.signal].filter((s): s is AbortSignal => s !== undefined)]);
    const request: ExtensionExecutionRequest = {
      taskId: this.options.taskId, branchId: this.options.branchId,
      subject: { kind: "extension", id: subjectId(entry) }, capability: "cmd.exec",
      // The only supported launcher is this process's Node binary (checked
      // above). Its absolute path remains parameter-bound; the command policy
      // uses the same canonical "node" name as built-in commands.
      resourceValues: ["node"],
      parameters: { extension: subjectId(entry), transport, operation, params },
    };
    try {
      await this.options.service.assertUsable(name, entry.reviewHash!);
      let invoked = false;
      return await this.options.execute(request, async (lease) => {
        if (invoked || this.usedLeases.has(lease.leaseId)) throw new ToolRefusedError("MCP lease callback is single-use", "lease_exhausted");
        invoked = true; checkLease(lease, request); this.usedLeases.add(lease.leaseId);
        return withReviewedPackage(entry.source.locator, entry.reviewHash!, async (workspace) => {
          const cwd = resolve(workspace, transport.cwd ?? ".");
          if (cwd !== workspace && !cwd.startsWith(`${workspace}/`)) throw new LocalPackageError("MCP cwd escapes reviewed package");
          const time = Math.min(5000, lease.constraints.timeoutMs ?? 5000,
            lease.budget.maxWallClockMs ?? 5000, Date.parse(lease.expiresAt) - Date.now());
          if (time < 1) throw new ToolRefusedError("MCP lease expired", "lease_expired");
          const timeout = new AbortController();
          const timedSignal = AbortSignal.any([combined, timeout.signal]);
          const timer = setTimeout(() => timeout.abort(), time);
          const session = new McpSession({
            command: transport.command, args: [
              "--experimental-permission", `--allow-fs-read=${workspace}`,
              "--input-type=module", "--eval",
              `${childReadOnlyPolicy([pathToFileURL(`${workspace}/`).href])}\nawait import(${JSON.stringify(pathToFileURL(resolve(cwd, transport.args[0]!)).href)});`,
              "--", ...transport.args.slice(1),
            ],
            cwd, env: { ...transport.env, ...probeEnvironment(workspace) },
            maxRestarts: 0, handshakeTimeoutMs: time, callTimeoutMs: time,
            maxFrameBytes: Math.min(64 * 1024, lease.constraints.maxOutputBytes ?? 64 * 1024,
              lease.budget.maxBytes ?? 64 * 1024),
          });
          const onAbort = () => { void session.stop(); };
          timedSignal.addEventListener("abort", onAbort, { once: true });
          const start = Date.now();
          try {
            timedSignal.throwIfAborted();
            checkLease(lease, request);
            await this.options.service.assertUsable(name, entry.reviewHash!);
            await session.start();
            const tools = await session.listTools();
            let text: string;
            let failed = false;
            if (operation === "tools/list") { discovered?.(tools); text = JSON.stringify(tools); }
            else {
              if (!tools.some((tool) => tool.name === params.name)) throw new LocalPackageError("MCP tool is not advertised by reviewed server");
              await this.options.service.assertUsable(name, entry.reviewHash!);
              checkLease(lease, request);
              const rendered = renderCallOutput(await session.callTool(String(params.name),
                params.arguments as Record<string, unknown>, { signal: timedSignal, timeoutMs: time }));
              text = rendered.text; failed = rendered.isError;
            }
            timedSignal.throwIfAborted();
            await this.options.service.assertUsable(name, entry.reviewHash!);
            return { status: failed ? "failed" : "succeeded", stdout: text,
              outputBytes: Buffer.byteLength(text), durationMs: Date.now() - start, changedPaths: [], truncated: false };
          } catch (error) {
            if (error instanceof LocalPackageError && /integrity|changed/.test(error.message)) throw error;
            return { status: combined.aborted ? "cancelled" : timeout.signal.aborted ? "timeout" : "failed",
              outputBytes: 0, durationMs: Date.now() - start, changedPaths: [], truncated: false,
              errorCode: "mcp_execution_incomplete" };
          } finally {
            clearTimeout(timer); timedSignal.removeEventListener("abort", onAbort); await session.stop();
          }
        }, combined);
      });
    } finally {
      calls.delete(controller); if (calls.size === 0) this.pending.delete(name);
    }
  }

  async verifiers(): Promise<readonly HostedExtensionVerifier[]> {
    return (await this.active("verifier")).filter((entry) => readOnlyEntry(entry.manifest)).map((entry) => ({
      descriptor: {
        id: `extension.${entry.manifest.name}`, version: entry.manifest.version, kind: "project_rule",
        evidenceLevel: "E1", canSatisfyRequiredCondition: false,
        independence: { mode: "separate_process", independentOf: [] },
        timeoutMs: 5000, requiresCommand: false, description: "Untrusted extension observation over a selected snapshot",
      },
      run: async (context) => {
        const result = await this.invoke(entry, {}, {
          conditions: context.conditions, changedPaths: context.changedPaths,
        }, true, context.signal);
        const status = result.status === "succeeded" ? "passed"
          : result.errorCode === "extension_verdict_failed" ? "failed" : "inconclusive";
        return { status, summary: result.stdout ?? "extension check did not complete", outputBytes: result.outputBytes,
          durationMs: result.durationMs, truncated: result.truncated,
          ...(status === "inconclusive" ? { incomplete: ["extension execution incomplete"] } : {}) };
      },
    }));
  }

  async skillContext(name: string, request: Parameters<typeof loadSkillContext>[1]): Promise<SkillContextFragment> {
    const entry = (await this.active("skill")).find((candidate) => candidate.manifest.name === name);
    if (entry === undefined) throw new LocalPackageError("Skill is not active");
    await this.options.service.assertUsable(name, entry.reviewHash!);
    const skill = await inspectSkill(entry.source.locator);
    if (skill === undefined) throw new LocalPackageError("Skill is not readable");
    const fragment = await loadSkillContext(skill, request);
    await this.options.service.assertUsable(name, entry.reviewHash!);
    return { ...fragment, provenance: { ...fragment.provenance,
      derivedFrom: [...fragment.provenance.derivedFrom, entry.reviewHash!] } };
  }

  private async invoke(entry: ExtensionLifecycleView, args: unknown, extra: Record<string, unknown>,
    verifier: boolean, signal?: AbortSignal,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const calls = this.pending.get(entry.manifest.name) ?? new Set<AbortController>();
    calls.add(controller);
    this.pending.set(entry.manifest.name, calls);
    const combined = AbortSignal.any([controller.signal, ...[signal, this.options.signal].filter((s): s is AbortSignal => s !== undefined)]);
    const request: ExtensionExecutionRequest = {
      taskId: this.options.taskId, branchId: this.options.branchId,
      subject: { kind: "extension", id: subjectId(entry) }, capability: "fs.read",
      resourceValues: [...this.options.resources],
      parameters: { extension: subjectId(entry), args, context: extra, resources: this.options.resources },
    };
    try {
      await this.options.service.assertUsable(entry.manifest.name, entry.reviewHash!);
      let invoked = false;
      return await this.options.execute(request, async (lease) => {
        if (invoked) throw new ToolRefusedError("execution callback is single-use", "lease_exhausted");
        invoked = true;
        checkLease(lease, request);
        if (this.usedLeases.has(lease.leaseId)) throw new ToolRefusedError("extension lease already used by this host", "lease_exhausted");
        this.usedLeases.add(lease.leaseId);
        if (combined.aborted) return { status: "cancelled", changedPaths: [], durationMs: 0, outputBytes: 0, truncated: false };
        await this.options.service.assertUsable(entry.manifest.name, entry.reviewHash!);
        return withReviewedPackage(entry.source.locator, entry.reviewHash!, async (workspace) => {
          const fixture = join(workspace, "__keystone_task_fixture__");
          await mkdir(fixture);
          await copyResources(this.options.rootPath, this.options.resources, fixture);
          // Revalidate after snapshot awaits and before any package code launches.
          checkLease(lease, request);
          await this.options.service.assertUsable(entry.manifest.name, entry.reviewHash!);
          const result = await runEntry(workspace, entry.manifest, args, {
            ...extra, rootPath: fixture, taskId: request.taskId, branchId: request.branchId,
          }, lease, combined, verifier);
          if (result.status === "timeout" || result.truncated) {
            await this.options.service.registry.isolate(entry.manifest.name,
              result.status === "timeout" ? "timeout" : "manifest_violation",
              result.status === "timeout" ? "task entry timed out" : "task entry exceeded output bounds", entry.reviewHash);
          }
          if (!combined.aborted && result.status !== "timeout" && !result.truncated) {
            await this.options.service.assertUsable(entry.manifest.name, entry.reviewHash!);
          }
          return result;
        }, combined);
      });
    } catch (error) {
      if (combined.aborted && !(error instanceof LocalPackageError && /integrity|changed/.test(error.message))) {
        return { status: "cancelled", changedPaths: [], durationMs: 0, outputBytes: 0, truncated: false };
      }
      throw error;
    } finally {
      calls.delete(controller);
      if (calls.size === 0) this.pending.delete(entry.manifest.name);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.detach();
    for (const calls of this.pending.values()) for (const controller of calls) controller.abort();
  }
}

export function createTaskExtensionHost(options: TaskExtensionHostOptions): TaskExtensionHost {
  return new TaskExtensionHost(options);
}
