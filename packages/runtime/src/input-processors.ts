/**
 * ADR-0015: input conversion is local maintenance, not Builder execution,
 * model authorization, Evidence or Proof. Plugins enter only TaskExtensionHost.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createTaskExtensionHost, type ExtensionLifecycleService } from "@keystone/extensions";
import {
  KernelSession, artifactPath, putArtifact, validateLease, withLock, writeFileAtomic,
  type KeystonePaths,
} from "@keystone/kernel";
import {
  arrayOf, attachmentSchema, autonomyEnvelopeSchema, bool, canonicalJson, contentHash,
  enumOf, int, lit, newId, nowIso, objectOf, optional, outcomeContractSchema,
  provenanceRefSchema, sha256Bytes, str, userDecisionSchema,
  type ArtifactId, type Capability, type CapabilityLease, type ExtensionManifest, type InferValidator, type InputAttachment, type TaskId,
} from "@keystone/schemas";
import { artifactIdValidator, projectIdValidator, sha256Validator } from "../../schemas/src/schemas/ids.ts";
import type { ToolResult } from "@keystone/tools";
import { AttachmentError } from "./attachments.ts";
import { assertStorePath } from "./data.ts";
import { ProjectRegistry } from "./projects/registry.ts";

const TEXT_BYTES = 10 * 1024 * 1024;
const PLUGIN_BYTES = 1024 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const TEXT_MIMES = ["text/plain", "text/markdown", "application/json", "text/csv"] as const;
const rangeValidator = objectOf({
  /** Lines/pages are one-based inclusive; bytes/time are zero-based, end-exclusive. */
  unit: enumOf(["line", "page", "byte", "millisecond"] as const),
  start: int({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  end: int({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});
export type ProcessorRange = InferValidator<typeof rangeValidator>;

const registrationValidator = objectOf({
  name: str({ pattern: /^[a-z][a-z0-9.-]{0,63}$/ }),
  kind: enumOf(["document", "audio", "vision"] as const),
  extensionName: str({ minLength: 1, maxLength: 128 }),
  mimeTypes: arrayOf(str({ pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, maxLength: 128 }), { minItems: 1, maxItems: 32 }),
  reviewHash: optional(sha256Validator),
});
export type InputProcessorRegistration = InferValidator<typeof registrationValidator>;
const configurationValidator = objectOf({
  projectId: projectIdValidator, name: str({ pattern: /^[a-z][a-z0-9.-]{0,63}$/ }),
  kind: enumOf(["document", "audio", "vision"] as const),
  extensionName: str({ minLength: 1, maxLength: 128 }),
  mimeTypes: arrayOf(str({ pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, maxLength: 128 }), { minItems: 1, maxItems: 32 }),
  reviewHash: str({ pattern: /^[a-f0-9]{64}$/ }), confirmed: bool(),
});
export type ConfigureProcessorInput = InferValidator<typeof configurationValidator> & { readonly signal?: AbortSignal };
const mappingValidator = objectOf({
  projectId: projectIdValidator, name: str({ pattern: /^[a-z][a-z0-9.-]{0,63}$/ }),
  kind: enumOf(["document", "audio", "vision"] as const), extensionName: str({ minLength: 1, maxLength: 128 }),
  mimeTypes: arrayOf(str({ pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, maxLength: 128 }), { minItems: 1, maxItems: 32 }),
  reviewHash: sha256Validator, version: str({ minLength: 1, maxLength: 128 }),
});
const mappingsValidator = objectOf({ version: lit("1"), mappings: arrayOf(mappingValidator, { maxItems: 64 }) });
export type InputProcessorMapping = InferValidator<typeof mappingValidator>;

const sourceValidator = objectOf({
  sourceId: str({ pattern: /^(?:input|attachment)\.[a-f0-9]{32}$/ }),
  projectId: projectIdValidator,
  name: str({ minLength: 1, maxLength: 255 }),
  mimeType: str({ pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, maxLength: 128 }),
  size: int({ min: 1, max: 20 * 1024 * 1024 }),
  artifactId: artifactIdValidator, contentHash: sha256Validator,
  status: enumOf(["ready", "removed"] as const),
  provenance: provenanceRefSchema.validator,
});
export type ProcessorSource = InferValidator<typeof sourceValidator>;

const requestValidator = objectOf({
  projectId: projectIdValidator,
  attachmentId: optional(str({ pattern: /^(?:input|attachment)\.[a-f0-9]{32}$/ })),
  raw: optional(objectOf({
    name: str({ minLength: 1, maxLength: 255 }),
    mimeType: str({ pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, maxLength: 128 }),
    data: str({ maxLength: Math.ceil(TEXT_BYTES / 3) * 4 }),
  })),
  processorName: str({ pattern: /^[a-z][a-z0-9.-]{0,63}$/ }),
  confirmed: bool(),
  range: optional(rangeValidator),
});
export type ProcessInput = InferValidator<typeof requestValidator> & { readonly signal?: AbortSignal };

export interface ProcessorIdentity {
  readonly name: string;
  readonly version: string;
  readonly extensionName?: string;
  readonly reviewHash?: string;
}

export interface ProcessorCapability {
  readonly name: string;
  readonly kind: "document" | "audio" | "vision";
  readonly available: boolean;
  readonly detail: string;
  readonly mimeTypes: readonly string[];
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly processor?: ProcessorIdentity;
}

export interface ProcessorResult {
  readonly attachment: InputAttachment;
  /** Bounded text for editing/preview; never interpreted as a task submission. */
  readonly text: string;
  readonly requiresReview: true;
  readonly source: ProcessorSource;
  readonly processor: ProcessorIdentity;
  readonly range: ProcessorRange;
  /** A plugin's page/time selection is requested, not independently verified. */
  readonly rangeBasis: "builtin" | "full-snapshot" | "requested";
  readonly taskId: TaskId;
  readonly autoSubmit: false;
}

export class InputProcessorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "InputProcessorError"; this.status = status; this.code = code;
  }
}

export interface ProcessorServiceOptions {
  readonly paths: KeystonePaths;
  readonly extensions?: ExtensionLifecycleService;
  /** Explicit MIME-to-reviewed-tool bindings; installing a plugin never selects it. */
  readonly processors?: readonly InputProcessorRegistration[];
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InputProcessorError(409, "processor_cancelled", "input processing cancelled; no task input submitted");
}

function plainName(name: string): void {
  if (/[\\/\x00-\x1f]/.test(name) || name === "." || name === "..") {
    throw new InputProcessorError(400, "invalid_filename", "input name must be a plain filename");
  }
}

function utf8(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new InputProcessorError(400, "binary_text", "binary input cannot be labelled as text");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new InputProcessorError(400, "invalid_utf8", "text input must be valid UTF-8"); }
}

function validateRange(range: ProcessorRange): void {
  if (range.end < range.start || ((range.unit === "line" || range.unit === "page") && range.start < 1) ||
      ((range.unit === "byte" || range.unit === "millisecond") && range.end === range.start)) {
    throw new InputProcessorError(400, "invalid_range", "input range must be nonempty and ordered");
  }
}

function readOnlyProcessor(manifest: ExtensionManifest): boolean {
  return manifest.kind === "tool" && manifest.entry !== undefined && manifest.transport === undefined &&
    manifest.capabilities.length === 1 && manifest.capabilities[0] === "fs.read" &&
    manifest.sideEffects.every((effect) => effect.kind === "fs_read") &&
    manifest.egressHosts.length === 0 && manifest.credentialHandles.length === 0;
}

/** Fixed allocation also bounds files growing after stat, with no symlink reads. */
async function boundedFile(paths: KeystonePaths, path: string, limit: number): Promise<Buffer> {
  await assertStorePath(paths, path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InputProcessorError(409, "source_missing", "original input metadata or artifact is missing");
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new InputProcessorError(413, "input_limit", "original input exceeds the regular-file size limit");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new InputProcessorError(413, "input_limit", "original input exceeds the size limit");
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

export class ProcessorService {
  private readonly paths: KeystonePaths;
  private readonly extensions?: ExtensionLifecycleService;
  private readonly processors: readonly InputProcessorRegistration[];
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  constructor(options: ProcessorServiceOptions) {
    this.paths = options.paths; this.extensions = options.extensions;
    this.processors = (options.processors ?? []).map((entry) => registrationValidator.parse(entry));
    if (this.processors.some((entry) => entry.name === "text-document") ||
        new Set(this.processors.map((entry) => entry.name)).size !== this.processors.length) {
      throw new InputProcessorError(400, "invalid_processors", "processor names must be distinct; text-document is reserved");
    }
    this.maxOutputBytes = int({ min: 1, max: OUTPUT_BYTES }).parse(options.maxOutputBytes ?? OUTPUT_BYTES);
    this.timeoutMs = int({ min: 1, max: 5000 }).parse(options.timeoutMs ?? 5000);
  }

  private mappingsFile(): string { return join(this.paths.home, "input-processors", "mappings.json"); }

  private async mappings(): Promise<readonly InputProcessorMapping[]> {
    try {
      return mappingsValidator.parse(JSON.parse((await boundedFile(this.paths, this.mappingsFile(), 128 * 1024)).toString("utf8"))).mappings;
    } catch (error) {
      if (error instanceof InputProcessorError && error.code === "source_missing") return [];
      throw new InputProcessorError(409, "invalid_mappings", "local input processor mappings are invalid or unsafe; recover configuration");
    }
  }

  async status(projectId?: string): Promise<{ processors: readonly ProcessorCapability[]; localOnly: true; autoSubmit: false }> {
    if (projectId !== undefined) projectIdValidator.parse(projectId);
    const capabilities: ProcessorCapability[] = [{
      name: "text-document", kind: "document", available: true,
      detail: "Built-in UTF-8 txt/md/json/csv/log reader; no PDF, office parser, OCR or transcription",
      mimeTypes: TEXT_MIMES, maxInputBytes: TEXT_BYTES, maxOutputBytes: this.maxOutputBytes,
      timeoutMs: this.timeoutMs, processor: { name: "text-document", version: "1.0.0" },
    }];
    const entries = await this.extensions?.list() ?? [];
    const bindings: readonly InputProcessorRegistration[] = [...this.processors,
      ...(await this.mappings()).filter((mapping) => mapping.projectId === projectId &&
        !this.processors.some((entry) => entry.name === mapping.name))];
    for (const binding of bindings) {
      const entry = entries.find((candidate) => candidate.manifest.name === binding.extensionName);
      let available = false;
      let detail = "Reviewed input processor extension unavailable or not active";
      let processor: ProcessorIdentity | undefined;
      if (entry?.reviewHash !== undefined) {
        const manifest = entry.manifest;
        processor = { name: binding.name, version: manifest.version, extensionName: binding.extensionName, reviewHash: entry.reviewHash };
        if (binding.reviewHash !== undefined && binding.reviewHash !== entry.reviewHash) {
          detail = "Input processor review hash changed; explicitly configure the reviewed version again";
        } else if (!readOnlyProcessor(manifest)) detail = "Input processors require a reviewed read-only tool entry without network, credentials or transport";
        else if (entry.lifecycleStatus === "active") {
          try {
            await this.extensions!.assertUsable(binding.extensionName, entry.reviewHash);
            available = true;
            detail = "Reviewed isolated local tool configured; output remains untrusted, conversion quality is not independently verified";
          } catch { detail = "Input processor unavailable: installed package integrity changed or activation was withdrawn"; }
        }
      }
      capabilities.push({ name: binding.name, kind: binding.kind, available, detail, mimeTypes: binding.mimeTypes,
        maxInputBytes: PLUGIN_BYTES, maxOutputBytes: this.maxOutputBytes, timeoutMs: this.timeoutMs,
        ...(processor === undefined ? {} : { processor }) });
    }
    for (const kind of ["document", "audio", "vision"] as const) {
      if (capabilities.some((entry) => entry.name === kind)) continue;
      capabilities.push({ name: kind, kind, available: false,
        detail: `${kind === "audio" ? "Speech transcription" : kind === "vision" ? "OCR/vision" : "PDF/office document"} processor not configured; install, review, activate and explicitly bind a read-only tool extension`,
        mimeTypes: [], maxInputBytes: PLUGIN_BYTES, maxOutputBytes: this.maxOutputBytes, timeoutMs: this.timeoutMs });
    }
    return { processors: capabilities, localOnly: true, autoSubmit: false };
  }

  async configure(input: ConfigureProcessorInput): Promise<{ configured: true; binding: InputProcessorMapping; taskId: TaskId }> {
    const { signal, ...raw } = input;
    let request: InferValidator<typeof configurationValidator>;
    try { request = configurationValidator.parse(raw); }
    catch { throw new InputProcessorError(400, "invalid_configuration", "invalid processor name, MIME mapping or review hash"); }
    if (!request.confirmed) throw new InputProcessorError(409, "confirmation_required", "explicit processor configuration confirmation required");
    cancelled(signal);
    if (request.name === "text-document" || this.processors.some((entry) => entry.name === request.name)) {
      throw new InputProcessorError(409, "reserved_processor", "built-in and static processor names are reserved; configure a distinct name");
    }
    const project = await new ProjectRegistry(this.paths).get(request.projectId);
    if (!project || project.archived || project.status !== "available") throw new InputProcessorError(409, "project_unavailable", "input project is unavailable");
    const entry = (await this.extensions?.list() ?? []).find((candidate) => candidate.manifest.name === request.extensionName);
    if (!entry || entry.reviewHash !== request.reviewHash) throw new InputProcessorError(409, "review_mismatch", "installed extension review hash is missing or changed");
    if (!readOnlyProcessor(entry.manifest) || entry.lifecycleStatus !== "active") {
      throw new InputProcessorError(409, "processor_unavailable", "configuration requires an active reviewed read-only tool without network or credentials");
    }
    await this.extensions!.assertUsable(request.extensionName, request.reviewHash);
    const { confirmed: _, ...mapping } = request;
    const binding = mappingValidator.parse({ ...mapping, version: entry.manifest.version });
    const file = this.mappingsFile();
    await assertStorePath(this.paths, file);
    const resource = this.resource(file);
    const session = await this.session(project, [resource], [resource, `${resource}.lock`, "input-processors", "artifacts/**"]);
    try {
      await this.effect(session, "fs.write", [resource, `${resource}.lock`], { operation: "configure-input-processor", binding }, async () => {
        await assertStorePath(this.paths, file);
        await withLock(`${file}.lock`, {}, async () => {
          const existing = await this.mappings();
          await this.extensions!.assertUsable(request.extensionName, request.reviewHash);
          const mappings = [...existing.filter((value) => value.projectId !== request.projectId || value.name !== request.name), binding];
          const value = mappingsValidator.parse({ version: "1", mappings });
          cancelled(signal);
          await writeFileAtomic(file, canonicalJson(value));
        });
      }, signal);
      return { configured: true, binding, taskId: session.taskId };
    } finally { await session.stop("input processor mapping recorded; no activation, model invocation or task completion"); }
  }

  private sourceFile(id: string): string {
    if (!/^(?:input|attachment)\.[a-f0-9]{32}$/.test(id)) throw new InputProcessorError(400, "invalid_source", "invalid input source ID");
    return id.startsWith("attachment.")
      ? join(this.paths.home, "inputs", `${id}.json`)
      : join(this.paths.home, "input-processors", "originals", `${id}.json`);
  }

  private async storedSource(id: string, projectId: string): Promise<ProcessorSource> {
    const raw: unknown = JSON.parse((await boundedFile(this.paths, this.sourceFile(id), 128 * 1024)).toString("utf8"));
    let source: ProcessorSource;
    if (id.startsWith("attachment.")) {
      const attachment = attachmentSchema.parse(raw);
      source = sourceValidator.parse({
        sourceId: attachment.attachmentId, projectId: attachment.projectId, name: attachment.name,
        mimeType: attachment.mimeType, size: attachment.size, artifactId: attachment.artifactId,
        contentHash: attachment.contentHash, status: attachment.status, provenance: attachment.provenance,
      });
    } else source = sourceValidator.parse(raw);
    if (source.sourceId !== id || source.projectId !== projectId || source.status !== "ready") {
      throw new InputProcessorError(409, "source_unavailable", "original input is removed or belongs to another project");
    }
    plainName(source.name);
    if (source.artifactId !== `art_${source.contentHash}`) throw new InputProcessorError(409, "source_hash_mismatch", "original artifact address and content hash differ");
    return source;
  }

  private accepts(capability: ProcessorCapability, source: { name: string; mimeType: string; size: number }): void {
    if (!capability.mimeTypes.includes(source.mimeType) ||
        (capability.name === "text-document" && !/\.(txt|md|json|csv|log)$/i.test(source.name))) {
      throw new InputProcessorError(415, "unsupported_input",
        `Unsupported ${source.mimeType} input for ${capability.name}; PDF/office/audio/vision need an explicitly configured reviewed processor`);
    }
    if (source.size > capability.maxInputBytes) throw new InputProcessorError(413, "input_limit",
      `Input exceeds ${capability.maxInputBytes} byte size limit${capability.name === "text-document" ? "" : " (isolated plugin snapshot: 1 MiB)"}`);
  }

  /** A narrow maintenance Contract, with no model routes or engineering actions. */
  private async session(project: { workspaceId: string; rootPath: string; name: string },
    reads: readonly string[], writes: readonly string[]): Promise<KernelSession> {
    const projectId = project.workspaceId;
    const at = nowIso();
    const budget = { maxTokens: 1, maxWallClockMs: 60_000, maxRetries: 0 };
    const autonomy = autonomyEnvelopeSchema.parse({
      projectId, readPaths: reads, writePaths: writes, allowedCommands: [], allowedHosts: [], allowedCredentials: [],
      externalSystems: "none", maxReversibility: "reversible", untrustedContentEgress: "deny_all",
      budget, updatedAt: at, updatedBy: "user", widenedBy: [],
    });
    const session = await KernelSession.create({
      paths: this.paths, projectId: projectId as never, requestedBy: "user", actorId: "workbench.input-processors",
      request: "Explicit local input conversion; do not execute an engineering task or submit model input",
      proposeContract: (input) => ({ contract: outcomeContractSchema.parse({
        contractId: newId("contract"), version: 1, taskId: input.taskId, projectId: input.projectId,
        createdAt: at, createdBy: "user", goal: input.request,
        scope: { include: [...reads.map((pattern) => ({ kind: "path", pattern, intent: "read" })),
          ...writes.map((pattern) => ({ kind: "glob", pattern, intent: "write" }))], exclude: [], unknown: [] },
        invariants: [], completionConditions: [{
          conditionId: "cond.input-maintenance", description: "Conversion is untrusted input, not proof of task completion",
          verifier: { kind: "custom", id: "input-maintenance-unavailable", version: "1" },
          minEvidenceLevel: "E3", requiresIndependence: true, required: true,
        }], budget, autonomy, uncertainties: [], interventionTriggers: [],
        exitConditions: [{ exitId: "exit.input-maintenance", kind: "user_stopped", description: "Stop after conversion; never evaluate Proof" }],
        status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
      }), questions: [] }),
    });
    try {
      await session.submit();
      await session.compile({ profile: {
        projectId: projectId as never, rootPath: project.rootPath, name: project.name, vcs: "git",
        languages: [], commands: [], instructionFiles: [], support: { status: "supported", reasons: [] },
        createdAt: at, updatedAt: at,
      }, budget, autonomy });
      await session.start();
      return session;
    } catch (error) { await session.stop("input maintenance initialization failed"); throw error; }
  }

  private resource(path: string): string { return relative(this.paths.home, path).split(sep).join("/"); }

  private async grant(session: KernelSession, capability: Capability, resources: readonly string[],
    parameters: unknown, signal?: AbortSignal, subject: CapabilityLease["subject"] = { kind: "orchestrator", id: "workbench.input-processors" },
  ): Promise<CapabilityLease> {
    cancelled(signal);
    const parametersHash = contentHash(parameters);
    const decision = userDecisionSchema.parse({
      decisionId: newId("dec"), taskId: session.taskId, branchId: session.branchId, at: nowIso(),
      decision: "allow", recordedBy: "user", rationale: "Explicit input conversion only; no model or task submission",
      modifications: { parametersHash }, appliesTo: { capability, resources, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await session.recordUserDecision(decision);
    cancelled(signal);
    const result = await session.authorizeOperation({ subject, capability, resourceValues: resources,
      parametersHash, decision, maxCalls: 1, ttlMs: 60_000, timeoutMs: this.timeoutMs,
      reversibility: "reversible", derivedFromUntrusted: true });
    if (!result.ok) throw new InputProcessorError(409, result.denial.code, `Input processor lease refused: ${result.denial.detail}`);
    cancelled(signal);
    const checked = validateLease(result.lease, { capability, resourceValues: resources, parametersHash });
    if (!checked.ok) throw new InputProcessorError(409, checked.denial.code, checked.denial.detail);
    return result.lease;
  }

  private async effect<T>(session: KernelSession, capability: "fs.read" | "fs.write" | "fs.delete",
    resources: readonly string[], parameters: unknown, run: () => Promise<T>, signal?: AbortSignal,
    artifact?: { artifactId: ArtifactId; sha256: string; bytes: number },
  ): Promise<T> {
    const lease = await this.grant(session, capability, resources, parameters, signal);
    const start = Date.now();
    let status: "succeeded" | "failed" | "cancelled" = "failed";
    try {
      cancelled(signal);
      const result = await run();
      cancelled(signal);
      status = "succeeded";
      return result;
    } catch (error) { if (signal?.aborted) status = "cancelled"; throw error; }
    finally {
      await session.recordExecution({ proposalId: newId("prop"), leaseId: lease.leaseId, status,
        durationMs: Date.now() - start, changedPaths: capability === "fs.read" ? [] : resources, origin: "human",
        ...(status === "succeeded" && artifact !== undefined
          ? { artifactId: artifact.artifactId, outputHash: artifact.sha256, outputBytes: artifact.bytes } : {}) });
    }
  }

  async process(input: ProcessInput): Promise<ProcessorResult> {
    const { signal, ...rawRequest } = input;
    let request: InferValidator<typeof requestValidator>;
    try { request = requestValidator.parse(rawRequest); }
    catch { throw new InputProcessorError(400, "invalid_request", "invalid processor request, filename, MIME, range or base64 size"); }
    if (request.confirmed !== true) throw new InputProcessorError(409, "confirmation_required", "explicit input processing confirmation required");
    cancelled(signal);
    if ((request.raw === undefined) === (request.attachmentId === undefined)) {
      throw new InputProcessorError(400, "invalid_source", "provide exactly one attachmentId or raw input");
    }
    if (request.range !== undefined) validateRange(request.range);
    const project = await new ProjectRegistry(this.paths).get(request.projectId);
    if (project === undefined || project.archived || project.status !== "available") {
      throw new InputProcessorError(409, "project_unavailable", "input project is missing, archived or unavailable");
    }
    const capability = (await this.status(request.projectId)).processors.find((entry) => entry.name === request.processorName);
    if (capability === undefined || !capability.available || capability.processor === undefined) {
      throw new InputProcessorError(409, "processor_unavailable", capability?.detail ?? "Input processor is not configured");
    }
    const processor = capability.processor;
    let source: ProcessorSource;
    let rawBytes: Buffer | undefined;
    if (request.raw !== undefined) {
      plainName(request.raw.name);
      const data = request.raw.data;
      if (data.length > Math.ceil(capability.maxInputBytes / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new InputProcessorError(413, "invalid_base64", "invalid or oversized base64 input");
      }
      rawBytes = Buffer.from(data, "base64");
      if (rawBytes.length === 0 || rawBytes.toString("base64") !== data) throw new InputProcessorError(400, "invalid_base64", "input must be nonempty canonical base64");
      this.accepts(capability, { ...request.raw, size: rawBytes.length });
      if (processor.name === "text-document") utf8(rawBytes);
      const hash = sha256Bytes(rawBytes);
      source = sourceValidator.parse({
        sourceId: `input.${randomBytes(16).toString("hex")}`, projectId: request.projectId,
        name: request.raw.name, mimeType: request.raw.mimeType, size: rawBytes.length,
        artifactId: `art_${hash}`, contentHash: hash, status: "ready",
        provenance: { provenanceId: newId("prov"), sourceKind: "user", trustLevel: "untrusted",
          locator: request.raw.name, derivedFrom: [], invalidatedBy: ["input.removed"], observedAt: nowIso() },
      });
    } else {
      source = await this.storedSource(request.attachmentId!, request.projectId);
      this.accepts(capability, source);
    }
    const upstream = [...new Set([source.provenance.provenanceId, ...source.provenance.derivedFrom])];
    if (upstream.length > 64) throw new InputProcessorError(409, "provenance_limit", "original provenance chain exceeds the derived attachment limit");
    const originalFile = artifactPath(this.paths, source.contentHash);
    const originalResource = this.resource(originalFile);
    const outputId = `attachment.${randomBytes(16).toString("hex")}`;
    const outputFile = join(this.paths.home, "inputs", `${outputId}.json`);
    const tmpResource = `input-processors/tmp/${randomBytes(16).toString("hex")}`;
    const snapshotResource = `${tmpResource}/original.bin`;
    const tmpPath = join(this.paths.home, tmpResource);
    const sourceFile = this.sourceFile(source.sourceId);
    for (const path of [this.paths.tasksDir, originalFile, outputFile, sourceFile, tmpPath]) await assertStorePath(this.paths, path);
    const writes = ["artifacts/**", this.resource(outputFile), `${tmpResource}/**`, tmpResource,
      "input-processors", "input-processors/tmp", this.resource(sourceFile), `${this.resource(sourceFile)}.lock`];
    const session = await this.session(project, [originalResource, snapshotResource], writes);
    let host: ReturnType<typeof createTaskExtensionHost> | undefined;
    let tmpCreated = false;
    let published = false;
    let completed = false;
    try {
      if (rawBytes !== undefined) {
        const bytes = rawBytes;
        await this.effect(session, "fs.write", [originalResource, this.resource(sourceFile)],
          { operation: "persist-original", source }, async () => {
            await assertStorePath(this.paths, originalFile);
            await assertStorePath(this.paths, sourceFile);
            cancelled(signal);
            await putArtifact(this.paths, bytes);
            cancelled(signal);
            await mkdir(dirname(sourceFile), { recursive: true, mode: 0o700 });
            await writeFileAtomic(sourceFile, canonicalJson(source));
          }, signal);
      }
      const bytes = await this.effect(session, "fs.read", [originalResource], { operation: "read-original", source }, async () => {
        const content = await boundedFile(this.paths, originalFile, capability.maxInputBytes);
        if (content.length !== source.size || sha256Bytes(content) !== source.contentHash) {
          throw new InputProcessorError(409, "source_hash_mismatch", "original input artifact hash or size changed");
        }
        return content;
      }, signal, { artifactId: source.artifactId, sha256: source.contentHash, bytes: source.size });
      let text: string;
      const range = request.range ?? { unit: "byte" as const, start: 0, end: source.size };
      let rangeBasis: ProcessorResult["rangeBasis"] = request.range === undefined ? "full-snapshot" : "requested";
      if (processor.name === "text-document") {
        const full = utf8(bytes);
        if (request.range === undefined) text = full;
        else {
          if (range.unit !== "line") throw new InputProcessorError(415, "unsupported_range", "text-document supports only explicit line ranges");
          const lines = full.split("\n");
          if (range.end > lines.length) throw new InputProcessorError(400, "invalid_range", "line range exceeds original text");
          text = lines.slice(range.start - 1, range.end).join("\n");
        }
        rangeBasis = "builtin";
      } else {
        await this.effect(session, "fs.write", ["input-processors", "input-processors/tmp", tmpResource, snapshotResource],
          { operation: "original-snapshot", source }, async () => {
            await assertStorePath(this.paths, tmpPath);
            cancelled(signal);
            await mkdir(dirname(tmpPath), { recursive: true, mode: 0o700 });
            await mkdir(tmpPath, { mode: 0o700 });
            tmpCreated = true;
            cancelled(signal);
            await writeFile(join(this.paths.home, snapshotResource), bytes, { flag: "wx", mode: 0o600 });
          }, signal);
        host = createTaskExtensionHost({
          service: this.extensions!, taskId: session.taskId, branchId: session.branchId,
          rootPath: this.paths.home, resources: [snapshotResource], signal,
          execute: async (execution, run) => {
            const lease = await this.grant(session, "fs.read", execution.resourceValues,
              execution.parameters, signal, execution.subject);
            const start = Date.now();
            let result: ToolResult = { status: "failed", outputBytes: 0, durationMs: 0, changedPaths: [], truncated: false };
            try { result = await run(lease); return result; }
            finally {
              await session.recordExecution({ proposalId: newId("prop"), leaseId: lease.leaseId,
                status: result.status, durationMs: Date.now() - start, outputBytes: result.outputBytes,
                changedPaths: [], ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) });
            }
          },
        });
        // Pin before executing so a concurrent same-name upgrade cannot substitute code.
        await host.tools();
        await this.extensions!.assertUsable(processor.extensionName!, processor.reviewHash!);
        const outcome = await host.callTool(`extension.${processor.extensionName}`, {
          path: snapshotResource, source, processor, range, maxOutputBytes: this.maxOutputBytes,
        }, signal);
        cancelled(signal);
        if (outcome.status !== "succeeded" || outcome.truncated) {
          throw new InputProcessorError(409, `processor_${outcome.status}`,
            outcome.status === "cancelled" ? "Input processor cancelled or unavailable" :
              outcome.status === "timeout" ? "Input processor exceeded timeout; no text published" :
                "Input processor failed or exceeded output bounds; no text published");
        }
        text = outcome.stdout ?? "";
      }
      const output = Buffer.from(text, "utf8");
      if (output.length === 0 || output.length > this.maxOutputBytes) {
        throw new InputProcessorError(413, "output_limit", "processor text output is empty or exceeds the output byte limit; select a smaller range");
      }
      if (utf8(output) !== text) throw new InputProcessorError(409, "invalid_output", "processor returned invalid Unicode text");
      const digest = sha256Bytes(output);
      const outputArtifact = artifactPath(this.paths, digest);
      const attachment = attachmentSchema.parse({
        attachmentId: outputId, projectId: request.projectId, name: `${source.name.slice(0, 235)}.processed.txt`,
        kind: "text", mimeType: "text/plain", size: output.length, artifactId: `art_${digest}`, contentHash: digest,
        status: "ready", createdAt: nowIso(), taskIds: [],
        provenance: { provenanceId: newId("prov"), sourceKind: processor.extensionName === undefined ? "tool" : "extension",
          trustLevel: "untrusted", locator: `${processor.name}@${processor.version}:${source.sourceId}`,
          derivedFrom: upstream, invalidatedBy: [...new Set([...source.provenance.invalidatedBy, "input.removed", "input.processor_changed"])],
          observedAt: nowIso(), transformation: "input-processor",
          extended: { source, processor, range, rangeBasis, taskId: session.taskId,
            outputRange: { unit: "line", start: 1, end: text.split("\n").length } },
        },
      });
      const receiptText = canonicalJson(attachment);
      const receiptHash = sha256Bytes(Buffer.from(receiptText));
      const receiptArtifact = artifactPath(this.paths, receiptHash);
      await this.effect(session, "fs.write",
        [this.resource(outputFile), this.resource(outputArtifact), this.resource(receiptArtifact), `${this.resource(sourceFile)}.lock`],
        { operation: "publish-derived-input", attachment }, async () => {
          await withLock(`${sourceFile}.lock`, {}, async () => {
            const current = await this.storedSource(source.sourceId, request.projectId);
            if (canonicalJson(current) !== canonicalJson(source)) throw new InputProcessorError(409, "source_changed", "original input metadata or provenance changed");
            if (processor.extensionName !== undefined) await this.extensions!.assertUsable(processor.extensionName, processor.reviewHash!);
            await assertStorePath(this.paths, outputFile);
            await assertStorePath(this.paths, outputArtifact);
            await assertStorePath(this.paths, receiptArtifact);
            cancelled(signal);
            await putArtifact(this.paths, output);
            cancelled(signal);
            await putArtifact(this.paths, receiptText);
            cancelled(signal);
            // Same validated record/layout as AttachmentStore.import, without
            // publishing a transient user-origin record or extending its API.
            await writeFileAtomic(outputFile, canonicalJson(attachment));
            published = true;
          });
        }, signal, { artifactId: `art_${receiptHash}` as ArtifactId, sha256: receiptHash, bytes: Buffer.byteLength(receiptText) });
      cancelled(signal);
      await host?.close();
      host = undefined;
      if (tmpCreated) {
        await this.effect(session, "fs.delete", [tmpResource], { operation: "cleanup-input-snapshot", sourceId: source.sourceId }, async () => {
          await assertStorePath(this.paths, tmpPath); await rm(tmpPath, { recursive: true, force: true });
        });
        tmpCreated = false;
      }
      cancelled(signal);
      completed = true;
      return { attachment, text, requiresReview: true, source, processor, range, rangeBasis, taskId: session.taskId, autoSubmit: false };
    } finally {
      try {
        await host?.close();
        // Cancellation denies new processing but permits bounded compensation.
        if (tmpCreated) await this.effect(session, "fs.delete", [tmpResource],
          { operation: "cleanup-input-snapshot", sourceId: source.sourceId }, async () => {
            await assertStorePath(this.paths, tmpPath); await rm(tmpPath, { recursive: true, force: true });
          });
        if (published && !completed) await this.effect(session, "fs.delete", [this.resource(outputFile)],
          { operation: "cancel-derived-input", attachmentId: outputId }, async () => {
            await assertStorePath(this.paths, outputFile); await rm(outputFile, { force: true });
          });
      } finally { await session.stop("input conversion maintenance stopped; no task submission or completion claimed"); }
    }
  }
}

export interface InputProcessorRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly projectId?: string;
}

/** Caller must authenticate first and pass its disconnect/cancellation signal. */
export async function routeInputProcessors(service: ProcessorService, request: InputProcessorRouteRequest):
Promise<{ status: number; body: unknown } | undefined> {
  if (!["/v1/input-processors", "/v1/input-processors/process", "/v1/input-processors/configure"].includes(request.pathname)) return undefined;
  const method = request.pathname === "/v1/input-processors" ? "GET" : "POST";
  if (request.method !== method) return { status: 405, body: { error: `Use ${method}`, code: "method_not_allowed" } };
  try {
    if (method === "GET") return { status: 200, body: await service.status(request.projectId) };
    if (request.pathname === "/v1/input-processors/configure") {
      const parsed = configurationValidator.parse(request.body);
      return { status: 200, body: await service.configure({ ...parsed, ...(request.signal === undefined ? {} : { signal: request.signal }) }) };
    }
    const parsed = requestValidator.parse(request.body);
    return { status: 200, body: await service.process({ ...parsed, ...(request.signal === undefined ? {} : { signal: request.signal }) }) };
  } catch (error) {
    if (error instanceof InputProcessorError || error instanceof AttachmentError) {
      return { status: error.status, body: { error: error.message, code: error instanceof InputProcessorError ? error.code : "attachment_unavailable" } };
    }
    return { status: 400, body: { error: "Input processor request or local storage is invalid; no model input submitted", code: "input_processor_failed" } };
  }
}
