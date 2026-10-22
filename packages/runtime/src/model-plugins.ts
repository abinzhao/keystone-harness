import { access, readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ExtensionLifecycleService, defaultRegistryLocation, runConformance,
} from "@keystone/extensions";
import { KernelSession, type KeystonePaths } from "@keystone/kernel";
import {
  buildAdapter, saveConfigSnapshot, loadConfigSnapshot, ModelUnavailableError, modelActionEnvelopeSchema,
  type CredentialResolver, type ModelAdapter, type ModelConfigEntry, type ModelRequest, type ModelTransportProposal,
} from "@keystone/models";
import {
  autonomyEnvelopeSchema, contentHash, extensionManifestSchema, newId, nowIso,
  outcomeContractSchema, projectProfileSchema, sha256Bytes, userDecisionSchema,
  type AutonomyEnvelope,
} from "@keystone/schemas";
import {
  createTraeCliAdapter, createTraeCliManifest, discoverTraeCliModels, probeTraeCli,
  TRAE_CLI_EXTENSION_NAME, TraeCliError, transportPolicy,
  type AuthorizeTransport, type CompatibilityResult, type TraeCliOptions,
} from "@keystone/extension-trae-cli";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../extension-trae-cli");
const SUBJECT = "keystone.trae-cli";

interface ApprovedIdentity {
  readonly canonicalCliPath: string;
  readonly approvedCliDigest: string;
  readonly approvedNativeAuthFile: string | null;
  readonly approvedNativeModelsFile: string | null;
}

export class ModelPluginError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "ModelPluginError"; this.status = status; }
}

async function declaration(hosts: readonly string[]) {
  const files: { path: string; digest: string }[] = [];
  const { readdir } = await import("node:fs/promises");
  for (const name of (await readdir(join(PACKAGE_ROOT, "src"))).filter(n => n.endsWith(".ts")).sort()) {
    const path = `src/${name}`, bytes = await readFile(join(PACKAGE_ROOT, path));
    files.push({ path, digest: sha256Bytes(bytes) });
  }
  const entry = files.find(file => file.path === "src/index.ts");
  if (!entry) throw new ModelPluginError(409, "bundled model plugin is unavailable");
  const manifest = extensionManifestSchema.parse(createTraeCliManifest({ digest: entry.digest, egressHosts: hosts }));
  return { manifest, reviewHash: contentHash({ manifest, files }), files };
}

async function defaultCliPath(): Promise<string | undefined> {
  for (const path of [join(homedir(), ".local/bin/trae-cli"),
    ...(process.env["PATH"] ?? "").split(":").filter(Boolean).map(root => join(root, "trae-cli"))]) {
    try { await access(path); if ((await stat(path)).isFile()) return path; } catch { /* Try the next executable candidate. */ }
  }
  return undefined;
}

function permission() {
  const policy = transportPolicy(SUBJECT);
  return { subjectId: policy.extensionSubject, executable: policy.executable, argvPrefix: [...policy.argvPrefix] };
}

async function nativeResource(name: "auth.json" | "models_cache.json"): Promise<string | undefined> {
  try {
    const file = await realpath(join(homedir(), ".trae/cli", name));
    if (!(await stat(file)).isFile()) throw new ModelPluginError(409, "native CLI resource is not a regular file; review required");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function executableDigest(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || !(info.mode & 0o111) || info.size > 512 * 1024 * 1024) {
    throw new ModelPluginError(409, "CLI executable cannot be verified; review required");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new ModelPluginError(409, "CLI executable exceeds the review limit");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function identify(options: TraeCliOptions): Promise<ApprovedIdentity> {
  const canonicalCliPath = await realpath(options.cliPath);
  return {
    canonicalCliPath, approvedCliDigest: await executableDigest(canonicalCliPath),
    approvedNativeAuthFile: options.nativeAuthFile ?? null,
    approvedNativeModelsFile: options.nativeModelsFile ?? null,
  };
}

async function verifyIdentity(cliPath: string, approved: ApprovedIdentity): Promise<void> {
  if (await realpath(cliPath) !== approved.canonicalCliPath ||
      await realpath(approved.canonicalCliPath) !== approved.canonicalCliPath ||
      await executableDigest(approved.canonicalCliPath) !== approved.approvedCliDigest ||
      (await nativeResource("auth.json") ?? null) !== approved.approvedNativeAuthFile ||
      (await nativeResource("models_cache.json") ?? null) !== approved.approvedNativeModelsFile) {
    throw new ModelPluginError(409, "CLI executable or native resource identity changed; review required");
  }
}

function verifyProposal(proposal: Parameters<AuthorizeTransport>[0], approved: ApprovedIdentity): void {
  const p = proposal.parameters;
  const network = p.purpose === "generate" || p.purpose === "models";
  if (proposal.subject.id !== SUBJECT || contentHash(p) !== proposal.parametersHash ||
      p.sourceExecutable !== approved.canonicalCliPath || p.cliDigest !== approved.approvedCliDigest ||
      (p.nativeAuthFile ?? null) !== (network ? approved.approvedNativeAuthFile : null) ||
      (p.nativeModelsFile ?? null) !== (network ? approved.approvedNativeModelsFile : null)) {
    throw new ModelPluginError(403, "transport proposal differs from the approved identity");
  }
}

/** Runtime composition for the bundled model extension; no dynamic host imports. */
export class ModelPluginService {
  private readonly paths: KeystonePaths;
  private readonly extensions: ExtensionLifecycleService;
  private readonly probes = new Map<string, { checked: CompatibilityResult; identity: ApprovedIdentity; at: number }>();
  private readonly isolation = new Map<string, Promise<void>>();
  private readonly pending = new Set<AbortController>();
  constructor(paths: KeystonePaths, extensions = new ExtensionLifecycleService(defaultRegistryLocation(paths.home))) {
    this.paths = paths; this.extensions = extensions;
  }

  async status() {
    const config = (await loadConfigSnapshot(this.paths)).config;
    const entry = config.models.find(model => model.protocol === "trae-cli-exec");
    const registrations = await this.extensions.list();
    const registration = registrations.find(row => row.manifest.name === TRAE_CLI_EXTENSION_NAME);
    let enabled = false;
    if (entry?.enabled && registration?.status === "active") {
      try { await this.assertApproved(entry); enabled = true; } catch { /* Projection never grants usability to an unverified entry. */ }
    }
    return {
      kind: "model", supported: process.platform === "darwin", available: process.platform === "darwin",
      cliPath: entry?.cliPath ?? await defaultCliPath(), endpointHost: entry?.endpointHost ?? "",
      egressHosts: entry?.egressHosts ?? [], enabled,
      allowPrivateNetwork: entry?.allowPrivateNetwork ?? false,
      dataEgress: { local: false, classes: ["internal"], destinations: entry?.egressHosts ?? [] },
      isolation: "macOS Seatbelt; bounded HTTPS CONNECT and TLS server-name allowlist",
      authentication: "CLI native login; credentials are not copied or exported",
      generationVerified: false,
    };
  }

  private async options(body: Record<string, unknown>): Promise<TraeCliOptions> {
    if (body["confirmed"] !== true) throw new ModelPluginError(400, "explicit confirmation is required");
    const cliPath = typeof body["cliPath"] === "string" ? body["cliPath"] : await defaultCliPath();
    const endpointHost = body["endpointHost"], egressHosts = body["egressHosts"];
    if (!cliPath?.startsWith("/") || typeof endpointHost !== "string" || !Array.isArray(egressHosts) ||
        egressHosts.length === 0 || egressHosts.length > 16 ||
        !egressHosts.every(host => typeof host === "string" &&
          /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) ||
        !egressHosts.includes(endpointHost)) {
      throw new ModelPluginError(400, "configure the CLI executable and exact public HTTPS destinations");
    }
    const nativeAuthFile = await nativeResource("auth.json");
    const nativeModelsFile = await nativeResource("models_cache.json");
    return { cliPath, endpointHost, egressHosts: egressHosts as string[], extensionSubject: SUBJECT,
      allowPrivateNetwork: body["allowPrivateNetwork"] === true,
      outputSchema: modelActionEnvelopeSchema.toJsonSchema(),
      ...(nativeAuthFile ? { nativeAuthFile } : {}), ...(nativeModelsFile ? { nativeModelsFile } : {}) };
  }

  private async withLifecycle<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.pending.add(controller);
    const detach = this.extensions.onUnavailable(name => {
      if (name === TRAE_CLI_EXTENSION_NAME) controller.abort();
    });
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try {
      if (combined.aborted) throw new TraeCliError("cancelled");
      const result = await run(combined);
      if (combined.aborted) throw new TraeCliError("cancelled");
      return result;
    } finally { detach(); this.pending.delete(controller); }
  }

  private quarantine(reviewHash: string): Promise<void> {
    const existing = this.isolation.get(reviewHash);
    if (existing) return existing;
    for (const controller of this.pending) controller.abort();
    const persisted = (async () => {
      try { await this.extensions.disable(TRAE_CLI_EXTENSION_NAME); }
      finally {
        await this.extensions.registry.isolate(TRAE_CLI_EXTENSION_NAME,
          "manifest_violation", "model transport isolation_violation", reviewHash);
      }
    })();
    this.isolation.set(reviewHash, persisted);
    return persisted;
  }

  private approvedIdentity(entry: ModelConfigEntry): ApprovedIdentity {
    if (!entry.canonicalCliPath?.startsWith("/") || !entry.approvedCliDigest?.match(/^[a-f0-9]{64}$/) ||
        entry.approvedNativeAuthFile === undefined) {
      throw new ModelUnavailableError(entry.id, "model transport identity pins are missing; review required", false);
    }
    return {
      canonicalCliPath: entry.canonicalCliPath, approvedCliDigest: entry.approvedCliDigest,
      approvedNativeAuthFile: entry.approvedNativeAuthFile,
      approvedNativeModelsFile: entry.approvedNativeModelsFile ?? null,
    };
  }

  private async assertApproved(entry: ModelConfigEntry): Promise<void> {
    const approved = this.approvedIdentity(entry);
    if (!entry.enabled || !entry.cliPath || !entry.egressHosts || this.isolation.has(entry.extensionReviewHash!)) {
      throw new ModelUnavailableError(entry.id, "model plugin is disabled or quarantined", false);
    }
    const current = await declaration(entry.egressHosts);
    const registered = (await this.extensions.list()).find(row => row.manifest.name === TRAE_CLI_EXTENSION_NAME);
    if (current.reviewHash !== entry.extensionReviewHash || registered?.reviewHash !== entry.extensionReviewHash ||
        registered?.status !== "active" || entry.extensionName !== TRAE_CLI_EXTENSION_NAME) {
      throw new ModelUnavailableError(entry.id, "model plugin is disabled or its reviewed bytes changed", false);
    }
    this.extensions.registry.assertDependencies(registered.manifest, true);
    try { await verifyIdentity(entry.cliPath, approved); }
    catch { throw new ModelUnavailableError(entry.id, "model transport identity changed; review required", false); }
  }

  private async inspect<T>(options: TraeCliOptions, run: (authorize: NonNullable<import("@keystone/models").ModelRequest["authorizeTransport"]>) => Promise<T>): Promise<T> {
    const projectId = newId("proj") as never;
    const budget = { maxTokens: 10000, maxWallClockMs: 240000, maxRetries: 0 };
    const autonomy = autonomyEnvelopeSchema.parse({
      projectId, readPaths: [], writePaths: [], allowedCommands: [], allowedHosts: [],
      allowedCredentials: options.nativeAuthFile ? ["trae-cli-native-login"] : [],
      modelTransports: [permission()], externalSystems: "none",
      maxReversibility: "reversible", untrustedContentEgress: "deny_all", budget,
      updatedAt: nowIso(), updatedBy: "user", widenedBy: [],
    });
    const session = await KernelSession.create({
      paths: this.paths, projectId, request: "Inspect the explicitly selected model transport.",
      requestedBy: "user", proposeContract: input => ({
        contract: outcomeContractSchema.parse({
          contractId: newId("contract"), version: 1, taskId: input.taskId, projectId,
          createdAt: nowIso(), createdBy: "kernel", goal: input.request,
          scope: { include: [], exclude: [], unknown: [] }, invariants: [],
          completionConditions: [{ conditionId: "cond.plugin_probe", description: "model transport check is an observation",
            verifier: { id: "plugin.probe", kind: "custom", version: "1.0.0" }, required: true,
            minEvidenceLevel: "E2", requiresIndependence: true }],
          budget, autonomy, uncertainties: [], interventionTriggers: [],
          exitConditions: [{ exitId: "exit.probe", kind: "external_dependency", description: "inspection finished without an engineering proof" }],
          status: "ready", schemaVersion: "keystone.contract.outcome@1.0.0",
        }), questions: [],
      }),
    });
    const leases: string[] = [];
    await session.submit();
    await session.compile({
      profile: projectProfileSchema.parse({
        projectId, rootPath: this.paths.home, name: "Model transport inspection", vcs: "git", languages: [],
        support: { status: "supported", reasons: [] }, commands: [], instructionFiles: [], createdAt: nowIso(), updatedAt: nowIso(),
      }), autonomy,
    });
    await session.start();
    const started = Date.now();
    try {
      return await run(async proposal => {
        if (proposal.subject.id !== SUBJECT || contentHash(proposal.parameters) !== proposal.parametersHash) {
          throw new ModelPluginError(403, "transport parameters or subject changed");
        }
        if ("nativeAuthFile" in proposal.parameters) {
          const auth = await session.authorizeOperation({
            subject: proposal.subject, capability: "credential.use", resourceValues: ["trae-cli-native-login"],
            parametersHash: proposal.parametersHash,
          });
          if (!auth.ok) throw new ModelPluginError(403, auth.denial.detail);
          leases.push(auth.lease.leaseId);
        }
        const grant = await session.authorizeOperation({
          subject: proposal.subject, capability: "cmd.exec", resourceValues: proposal.resource.values,
          parametersHash: proposal.parametersHash, workingDirectory: proposal.parameters.cwd,
          timeoutMs: proposal.parameters.timeoutMs, maxOutputBytes: proposal.parameters.maxOutputBytes,
          argvPrefix: ["-p"], ttlMs: Math.min(300000, proposal.parameters.timeoutMs + 5000),
        });
        if (!grant.ok) throw new ModelPluginError(403, grant.denial.detail);
        leases.push(grant.lease.leaseId); return grant.lease;
      });
    } finally {
      for (const leaseId of leases) await session.consumeExecutionLease(leaseId);
      await session.recordBudget({ wallClockMs: Date.now() - started, reason: "model transport inspection", measured: true });
      await session.stop("model transport inspection ended; no engineering completion claimed");
    }
  }

  async operate(kind: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const options = await this.options(body);
    const modelName = typeof body["modelId"] === "string" ? body["modelId"] : "";
    const declared = await declaration(options.egressHosts);
    const key = contentHash({ options, modelName, reviewHash: declared.reviewHash });
    if (kind === "discover" || kind === "probe") {
      if (kind === "probe" && !modelName) throw new ModelPluginError(400, "select a discovered model");
      this.probes.delete(key);
      const identity = await identify(options);
      return this.withLifecycle(undefined, signal => this.inspect(options, async authorize => {
        const check = async () => {
          if (signal.aborted) throw new TraeCliError("cancelled");
          await verifyIdentity(options.cliPath, identity);
          if ((await declaration(options.egressHosts)).reviewHash !== declared.reviewHash) {
            throw new ModelPluginError(409, "plugin changed during inspection; review required");
          }
          if (signal.aborted) throw new TraeCliError("cancelled");
          return true;
        };
        const authorizeTransport: AuthorizeTransport = async proposal => {
          await check(); verifyProposal(proposal, identity);
          return authorize(proposal);
        };
        const bound = { ...options, signal, authorizeTransport, checkIntegrity: check, isActive: check };
        if (kind === "discover") {
          const compatibility = await probeTraeCli(bound);
          const models = await discoverTraeCliModels(bound);
          await check();
          return { ok: true, compatibility, reviewHash: declared.reviewHash, models: models.map(model => ({
            id: model.modelName, modelName: model.modelName, name: model.displayName, available: true,
          })) };
        }
        const adapter = await createTraeCliAdapter({ ...bound, modelName });
        const result = await adapter.complete({
          messages: [{ role: "user", content: 'Return {"summary":"Connection checked","answer":"OK","actions":[]}.' }],
          tools: [], jsonMode: true, authorizeTransport, signal,
        });
        await check();
        if (adapter.compatibility.cliPath !== identity.canonicalCliPath || adapter.compatibility.cliDigest !== identity.approvedCliDigest) {
          throw new ModelPluginError(409, "CLI changed during the generation check");
        }
        this.probes.set(key, { checked: adapter.compatibility, identity, at: Date.now() });
        return { ok: true, modelId: modelName, compatibility: adapter.compatibility, usage: result.usage,
          reviewHash: declared.reviewHash, engineeringProof: false };
      }));
    }
    if (!modelName) throw new ModelPluginError(400, "select a discovered model");
    if (kind !== "enable") throw new ModelPluginError(404, "unknown model plugin operation");
    const probe = this.probes.get(key);
    if (!probe || Date.now() - probe.at > 600000) throw new ModelPluginError(409, "run a generation check for this exact configuration before enabling");
    const config = await loadConfigSnapshot(this.paths);
    await verifyIdentity(options.cliPath, probe.identity);
    const conformance = await runConformance({
      manifest: declared.manifest, integrityVerified: true,
      probes: [{ checkId: "transport.live_probe", blocking: true, detail: "bound generation probe",
        run: async () => ({ passed: true, detail: "Synthetic generation completed under exact reviewed transport" }) }],
    });
    const registered = await this.extensions.registry.register({
      manifest: declared.manifest, source: { kind: "bundled", locator: PACKAGE_ROOT },
      reviewHash: declared.reviewHash, files: declared.files.map(file => ({ ...file, bytes: 0, mode: 0o644 })),
      integrityVerified: true, conformance,
    });
    await verifyIdentity(options.cliPath, probe.identity);
    await this.extensions.registry.activate(registered.manifest.name, {
      reviewHash: declared.reviewHash,
      decision: userDecisionSchema.parse({
        decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: nowIso(),
        recordedBy: "user", decision: "allow", rationale: "explicit checked model-plugin activation",
        appliesTo: { capability: "extension.activate", resources: [declared.reviewHash] },
      }),
    });
    const id = `trae-${contentHash({ cliPath: options.cliPath, modelName, hosts: options.egressHosts }).slice(0, 40)}`;
    const entry: ModelConfigEntry = {
      id, kind: "cloud", provider: "trae-cli", protocol: "trae-cli-exec", modelName, cliPath: options.cliPath,
      endpointHost: options.endpointHost, egressHosts: [...options.egressHosts], extensionName: TRAE_CLI_EXTENSION_NAME,
      extensionReviewHash: declared.reviewHash, enabled: true, contextTokens: 32000,
      allowPrivateNetwork: options.allowPrivateNetwork === true,
      ...probe.identity,
    };
    await verifyIdentity(options.cliPath, probe.identity);
    await saveConfigSnapshot(this.paths, { revision: config.revision, config: {
      ...config.config, schemaVersion: "keystone.config@2.2.0",
      models: [...config.config.models.filter(model => model.id !== id), entry],
      routes: { ...config.config.routes, builder: [id] },
    } });
    this.isolation.delete(declared.reviewHash);
    this.probes.delete(key);
    return { ok: true, enabled: true, modelId: id, reviewHash: declared.reviewHash };
  }

  build(entry: ModelConfigEntry): ModelAdapter {
    if (entry.protocol !== "trae-cli-exec" || !entry.cliPath || !entry.egressHosts || !entry.extensionReviewHash) {
      throw new Error("invalid model plugin configuration");
    }
    entry = structuredClone(entry);
    const hosts = entry.egressHosts!, reviewHash = entry.extensionReviewHash!;
    return {
      configurationDigest: contentHash(entry),
      descriptor: {
        id: entry.id, kind: "cloud", provider: "trae-cli", modelName: entry.modelName,
        endpointHost: entry.endpointHost, protocol: "trae-cli-exec",
        capabilities: { nativeTools: false, structuredOutput: true, streaming: false, multimodal: false,
          contextTokens: entry.contextTokens ?? 32000 },
        dataEgress: { local: false, classes: ["internal"] },
      },
      transportPermission: permission(),
      complete: async (request: ModelRequest) => this.withLifecycle(request.signal, async signal => {
        const approved = this.approvedIdentity(entry);
        if (!request.authorizeTransport) throw new ModelUnavailableError(entry.id, "model transport admission is unavailable", false);
        const check = async () => {
          if (signal.aborted) throw new TraeCliError("cancelled");
          await this.assertApproved(entry);
          if (signal.aborted) throw new TraeCliError("cancelled");
          return true;
        };
        const authorizeTransport: AuthorizeTransport = async proposal => {
          await check(); verifyProposal(proposal, approved);
          return request.authorizeTransport!(proposal);
        };
        let isolation: Promise<void> | undefined;
        try {
          await check();
          const adapter = await createTraeCliAdapter({
            cliPath: entry.cliPath!, endpointHost: entry.endpointHost, egressHosts: hosts, modelName: entry.modelName,
            allowPrivateNetwork: entry.allowPrivateNetwork === true,
            outputSchema: modelActionEnvelopeSchema.toJsonSchema(),
            id: entry.id, extensionSubject: SUBJECT, authorizeTransport, signal,
            isActive: check, checkIntegrity: check,
            onIsolationViolation: () => { isolation = this.quarantine(reviewHash); },
            ...(approved.approvedNativeAuthFile ? { nativeAuthFile: approved.approvedNativeAuthFile } : {}),
            ...(approved.approvedNativeModelsFile ? { nativeModelsFile: approved.approvedNativeModelsFile } : {}),
          });
          // CLI max-output-token control is not negotiated; its measured usage and
          // process/input/output ceilings remain authoritative for this transport.
          const response = await adapter.complete({ ...request, authorizeTransport, signal, maxTokens: undefined, temperature: undefined });
          await check();
          return response;
        } finally { await isolation; }
      }),
    };
  }
}

export function buildRuntimeAdapter(entry: ModelConfigEntry, credentials: CredentialResolver,
  plugins: ModelPluginService): ModelAdapter {
  return buildAdapter(entry, credentials, { pluginFactory: model => plugins.build(model) });
}

export function withModelTransportPermissions(autonomy: AutonomyEnvelope, models: readonly ModelAdapter[]): AutonomyEnvelope {
  const modelTransports = models.flatMap(model => model.transportPermission ? [model.transportPermission] : []);
  return modelTransports.length ? autonomyEnvelopeSchema.parse({
    ...autonomy, modelTransports, allowedCredentials: [...new Set([...autonomy.allowedCredentials, "trae-cli-native-login"])],
  }) : autonomy;
}
