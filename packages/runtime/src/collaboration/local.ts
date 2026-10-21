import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  consumeLease, KernelSession, writeFileAtomic, type KeystonePaths,
} from "@keystone/kernel";
import { canonicalJson, contentHash, experienceEntrySchema, newId, projectFactSchema, sha256Bytes, type CapabilityLease } from "@keystone/schemas";
import { assertStorePath } from "../data.ts";
import { assertBundleRoot, collectPreview, collectTaskBundle, localRoots, writePortableFiles } from "./local-io.ts";
import { boundedRead, portablePath, previewBundle, type BundlePreview } from "./bundles.ts";
import { DelegationClient, delegationBinding, type DelegationRequest, type RemoteObservation } from "./delegation.ts";
import { CollaborationService } from "./service.ts";
import { publicKeyDigest, rejectSecrets, signDocument, type PeerIdentity, type SignedDocument } from "./signatures.ts";
import { authorizedLease, localDecision, maintenanceSession, sessionQueue, type LocalProject } from "./local-session.ts";

export interface LocalCollaborationOptions {
  /** A callback tracks data-home migration; no roots are captured at construction. */
  readonly paths: KeystonePaths | (() => KeystonePaths);
  readonly projects: () => Promise<readonly LocalProject[]> | readonly LocalProject[];
}
/** Passed by the authenticated server, never read from a request body. */
export interface LocalUiContext { readonly authenticated: true; readonly source: "local_ui" }
interface PublicPeer extends PeerIdentity { readonly endpoint?: string; readonly trustLevel: "untrusted" }
interface QuarantinedImport {
  importId: string; destination: string; digest: string; sourceTaskId: string; trustLevel: "untrusted";
  authority: "imported_candidate"; taskId: string; eventId: string; adoptedTaskId?: string;
}
interface LocalDelegation {
  delegationId: string; digest: string; signed: SignedDocument; session: KernelSession;
  paths: KeystonePaths; project: LocalProject; controller: AbortController;
  queue: ReturnType<typeof sessionQueue>; state: "prepared" | "sending" | "observed" | "failed" | "stopped";
  client?: DelegationClient; pending?: Promise<unknown>; observation?: RemoteObservation;
}

class LocalRefusal extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function text(value: unknown, name: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LocalRefusal(`invalid ${name}`);
  return value.trim();
}
function endpoint(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const url = new URL(text(value, "endpoint"));
  if (url.username || url.password || url.hash || url.search ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new LocalRefusal("endpoint must be public HTTPS or literal loopback HTTP without credentials");
  }
  return url.href;
}
function confirm(body: Record<string, unknown>, context?: LocalUiContext) {
  if (context?.authenticated !== true || context.source !== "local_ui") throw new LocalRefusal("authenticated local UI admission required", 403);
  if (body["confirmed"] !== true) throw new LocalRefusal("explicit local UI confirmation required");
  if (body["decisionId"] !== undefined) throw new LocalRefusal("request decisionId is not recorded user consent");
}

export function createLocalCollaboration(options: LocalCollaborationOptions) {
  const keys = generateKeyPairSync("ed25519");
  const identity = {
    identityId: newId("peer"), algorithm: "Ed25519" as const,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    retention: "session_only" as const, trustLevel: "untrusted" as const,
  };
  const service = new LocalCollaborationService(options, identity,
    (document, binding) => signDocument(document, binding, identity.identityId, keys.privateKey));
  return { service, identity: () => ({ ...identity }), dispose: () => service.dispose() };
}

/** Owns only local projections and dedicated operation sessions; never a running engineering session. */
class LocalCollaborationService extends CollaborationService {
  private readonly local: LocalCollaborationOptions;
  private readonly identityValue: {
    identityId: string; algorithm: "Ed25519"; publicKey: string; retention: "session_only"; trustLevel: "untrusted";
  };
  private readonly signer: (document: unknown, binding: Parameters<typeof signDocument>[1]) => SignedDocument;
  private readonly peersValue: PublicPeer[] = [];
  private readonly imports = new Map<string, QuarantinedImport>();
  private readonly delegations = new Map<string, LocalDelegation>();
  private readonly mutateQueue = sessionQueue();
  private loadedHome = "";
  private disposed = false;

  constructor(options: LocalCollaborationOptions,
    identity: { identityId: string; algorithm: "Ed25519"; publicKey: string; retention: "session_only"; trustLevel: "untrusted" },
    signer: (document: unknown, binding: Parameters<typeof signDocument>[1]) => SignedDocument) {
    const peers: PublicPeer[] = [];
    super({ peers: () => [{ ...identity, revoked: false }, ...peers] });
    this.local = options; this.identityValue = identity; this.signer = signer;
    this.peersValue = peers;
  }
  private paths() { return typeof this.local.paths === "function" ? this.local.paths() : this.local.paths; }
  private async project(id: unknown) {
    const selected = (await this.local.projects()).find((p) => p.projectId === id);
    if (!selected || selected.status !== "available" || selected.archived) throw new LocalRefusal("available local project required");
    return selected;
  }
  private async refreshPeers() {
    try { await this.loadPeers(); }
    catch (error) {
      this.peersValue.splice(0);
      for (const delegation of this.delegations.values()) await this.stopDelegation(delegation);
      throw error;
    }
    for (const d of this.delegations.values()) {
      const request = d.signed.document as DelegationRequest;
      if (!this.peersValue.some((p) => p.identityId === request.recipientId && !p.revoked && p.endpoint === request.endpoint)) {
        await this.stopDelegation(d);
      }
    }
  }
  private async loadPeers() {
    const paths = this.paths();
    if (this.loadedHome && this.loadedHome !== paths.home) {
      for (const delegation of this.delegations.values()) await this.stopDelegation(delegation);
      this.imports.clear();
    }
    this.loadedHome = paths.home;
    const file = join(localRoots(paths).root, "peers.json");
    await assertStorePath(paths, file);
    let raw: unknown;
    try { raw = JSON.parse((await boundedRead(paths.home, "collaboration/peers.json", 1024 * 1024)).toString("utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.peersValue.splice(0); return; } throw error; }
    rejectSecrets(raw);
    if (!Array.isArray(raw) || raw.length > 256) throw new LocalRefusal("public peer registry rejected");
    const parsed = raw.map((value: Record<string, unknown>) => {
      const peerId = text(value["identityId"], "peer identity", 128);
      const publicKey = text(value["publicKey"], "public key", 1024);
      publicKeyDigest(publicKey);
      if (typeof value["revoked"] !== "boolean" || value["trustLevel"] !== "untrusted" ||
          Object.keys(value).some((k) => !["identityId", "publicKey", "endpoint", "revoked", "trustLevel"].includes(k))) {
        throw new LocalRefusal("public peer registry rejected");
      }
      const declared = endpoint(value["endpoint"]);
      return { identityId: peerId, publicKey, revoked: value["revoked"], trustLevel: "untrusted" as const,
        ...(declared ? { endpoint: declared } : {}) };
    });
    if (new Set(parsed.map((p) => p.identityId)).size !== parsed.length) throw new LocalRefusal("duplicate pinned peer");
    this.peersValue.splice(0, this.peersValue.length, ...parsed);
  }
  override status() {
    return { ...super.status(), identity: { ...this.identityValue }, peers: structuredClone(this.peersValue),
      roots: localRoots(this.paths()), portableBundles: "lease-gated local export and quarantine import",
      initializationAvailable: true, importAvailable: true, adoptionAvailable: false, taskAdoptionAvailable: true,
      candidateAdoptionReason: "No trust-preserving project promotion API; imported candidates stay untrusted.",
      imports: [...this.imports.values()].map((v) => ({ ...v })),
      delegation: { version: "keystone.delegation/1" as const, requests: this.delegations.size,
        outboundAvailable: true, transport: "explicit opt-in; dedicated parent task; local fixture protocol" },
      delegations: [...this.delegations.values()].map((d) => ({
        delegationId: d.delegationId, taskId: d.session.taskId, digest: d.digest, status: d.state,
        endpoint: (d.signed.document as DelegationRequest).endpoint, trustLevel: "untrusted",
        request: structuredClone(d.signed.document),
      })),
      retention: "Public peers and package bytes persist; identity and workflow projections are session-only.",
    };
  }
  override async preview(input: { root: string }): Promise<BundlePreview> {
    const paths = this.paths(); const roots = localRoots(paths);
    const root = text(input.root, "bundle root");
    await assertStorePath(paths, root);
    await assertBundleRoot(root, [roots.exports, roots.inbox]);
    return previewBundle(root);
  }
  private async initialize(body: Record<string, unknown>) {
    const project = await this.project(body["projectId"]); const paths = this.paths();
    const roots = localRoots(paths); const resources = Object.values(roots);
    for (const resource of resources) await assertStorePath(paths, resource);
    const session = await maintenanceSession(paths, project, { goal: "Initialize explicitly authorized local exchange directories", resources });
    try {
      const parameters = { directories: resources };
      const decision = await localDecision(session, "fs.write", resources, parameters);
      const lease = await authorizedLease(session, "fs.write", resources, contentHash(parameters), decision);
      await session.consumeExecutionLease(lease.leaseId);
      for (const resource of resources) {
        await assertStorePath(paths, resource); await mkdir(resource, { recursive: true, mode: 0o700 });
      }
      await session.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 0, changedPaths: resources });
      return { taskId: session.taskId, roots, status: "initialized" };
    } finally { await session.stop("exchange initialized; no completion claimed"); }
  }
  private async peerAction(body: Record<string, unknown>, revoke: boolean) {
    const project = await this.project(body["projectId"]); const paths = this.paths(); const root = localRoots(paths).root;
    const identityId = text(body["identityId"], "peer identity", 128);
    const current = this.peersValue.find((p) => p.identityId === identityId);
    if (identityId === this.identityValue.identityId || (revoke ? !current || current.revoked : current !== undefined)) {
      throw new LocalRefusal("peer already pinned/revoked or unavailable; key changes need a new identity");
    }
    if (this.peersValue.length >= 256 && !revoke) throw new LocalRefusal("public peer capacity exceeded");
    const publicKey = revoke ? current!.publicKey : text(body["publicKey"], "public key", 1024);
    publicKeyDigest(publicKey);
    const canonicalKey = createPublicKey(publicKey).export({ type: "spki", format: "pem" }).toString();
    const declared = revoke ? current!.endpoint : endpoint(body["endpoint"]);
    const peer: PublicPeer = { identityId, publicKey: canonicalKey, revoked: revoke, trustLevel: "untrusted",
      ...(declared ? { endpoint: declared } : {}) };
    const next = revoke ? this.peersValue.map((p) => p.identityId === identityId ? peer : p) : [...this.peersValue, peer];
    const resources = [root, join(root, "peers.json")];
    await assertStorePath(paths, resources[1]!);
    const session = await maintenanceSession(paths, project, { goal: revoke ? "Revoke public collaboration peer" : "Pin public collaboration peer", resources });
    try {
      const parameters = { action: revoke ? "revoke" : "register", peer, registryDigest: contentHash(next) };
      const decision = await localDecision(session, "fs.write", resources, parameters);
      const lease = await authorizedLease(session, "fs.write", resources, contentHash(parameters), decision);
      await session.consumeExecutionLease(lease.leaseId);
      await assertStorePath(paths, resources[1]!);
      await writeFileAtomic(resources[1]!, canonicalJson(next));
      await session.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 0, changedPaths: resources });
      this.peersValue.splice(0, this.peersValue.length, ...next);
      if (revoke) for (const d of this.delegations.values()) {
        if ((d.signed.document as DelegationRequest).recipientId === identityId) await this.stopDelegation(d);
      }
      return { peer, taskId: session.taskId };
    } finally { await session.stop("public peer decision recorded; no completion claimed"); }
  }
  private async exportTask(body: Record<string, unknown>) {
    const project = await this.project(body["projectId"]); const paths = this.paths();
    const bundle = await collectTaskBundle(paths, text(body["taskId"], "task identity"),
      body["branchId"] === undefined ? undefined : text(body["branchId"], "branch identity"),
      { includeRecoveryWorkspace: body["includeRecoveryWorkspace"] === true });
    if (bundle.projectId !== project.workspaceId) throw new LocalRefusal("task belongs to a different local project");
    const root = join(localRoots(paths).exports, newId("bundle"));
    const receipt = await writePortableFiles(paths, project, root, bundle, "Export reviewed public portable task bundle");
    const preview = await previewBundle(root);
    return { ...receipt, root, digest: preview.digest, authority: "integrity_only",
      includesRecoveryWorkspace: body["includeRecoveryWorkspace"] === true,
      signature: this.signer({ digest: preview.digest, taskId: preview.taskId, authority: "imported_candidate" }, {
        purpose: "bundle", taskId: preview.taskId,
        contractDigest: contentHash(preview.events.filter((e) => e.type === "contract.compiled" || e.type === "contract.revised")),
        environmentDigest: preview.environmentDigest, conditionIds: [], issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      }) };
  }
  private async quarantine(body: Record<string, unknown>) {
    if (body["destination"] !== undefined) throw new LocalRefusal("quarantine destination is assigned locally, not supplied by request");
    if (this.imports.size >= 1024) throw new LocalRefusal("import projection capacity exceeded");
    const project = await this.project(body["projectId"]); const paths = this.paths();
    const bundle = await this.preview({ root: text(body["root"], "bundle root") });
    if (body["digest"] !== bundle.digest) throw new LocalRefusal("reviewed bundle digest changed");
    const files = await collectPreview(bundle);
    const importId = newId("import"); const destination = join(localRoots(paths).quarantine, importId);
    const receipt = await writePortableFiles(paths, project, destination, files, "Import reviewed package to untrusted quarantine");
    const imported: QuarantinedImport = { ...receipt, importId, destination, digest: bundle.digest,
      sourceTaskId: bundle.taskId, authority: "imported_candidate", trustLevel: "untrusted" };
    this.imports.set(importId, imported);
    return { ...imported };
  }
  private async adoptTask(body: Record<string, unknown>) {
    const imported = this.imports.get(text(body["importId"], "import identity"));
    if (!imported || imported.adoptedTaskId || body["digest"] !== imported.digest) throw new LocalRefusal("import digest changed or already adopted");
    const project = await this.project(body["projectId"]); const paths = this.paths();
    await assertStorePath(paths, imported.destination);
    const bundle = await previewBundle(imported.destination);
    if (bundle.digest !== imported.digest) throw new LocalRefusal("quarantine integrity changed");
    const request = text(body["request"], "fresh local task request", 4000);
    const session = await KernelSession.create({ paths, projectId: project.workspaceId as never,
      requestedBy: "user", actorId: "workbench.collaboration", request,
      references: [{ kind: "text", value: canonicalJson({ authority: "imported_candidate", trustLevel: "untrusted",
        importId: imported.importId, sourceTaskId: bundle.taskId, sourceBranchId: bundle.branchId,
        sourceDigest: bundle.digest, locator: imported.destination, limitations: bundle.limitations }) }],
    });
    await localDecision(session, undefined, [imported.destination], { digest: bundle.digest, request });
    imported.adoptedTaskId = session.taskId;
    return { taskId: session.taskId, status: "draft", authority: "fresh_local_task", sourceTrustLevel: "untrusted" };
  }
  private async localSources(project: LocalProject) {
    const paths = this.paths();
    const read = async (file: string): Promise<unknown[]> => {
      await assertStorePath(paths, file);
      let bytes: Buffer;
      try { bytes = await boundedRead(paths.home, relative(paths.home, file).split(sep).join("/"), 4 * 1024 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      if (!bytes.length) return [];
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n")) throw new LocalRefusal("local source projection is incomplete");
      const rows = text.slice(0, -1).split("\n");
      if (rows.length > 4096) throw new LocalRefusal("local sharing source count limit exceeded");
      return rows.map((line) => { const value: unknown = JSON.parse(line); rejectSecrets(value); return value; });
    };
    const facts = new Map((await read(paths.factsFile(project.workspaceId as never))).map((raw) => {
      const fact = projectFactSchema.parse(raw);
      if (fact.projectId !== project.workspaceId) throw new LocalRefusal("local source project changed");
      return [fact.factId, fact];
    }));
    const entries = new Map((await read(paths.experienceEntriesFile(project.workspaceId as never))).map((raw) => {
      const entry = experienceEntrySchema.parse(raw);
      if (entry.projectId !== project.workspaceId) throw new LocalRefusal("local source project changed");
      return [entry.entryId, entry];
    }));
    return [
      ...[...facts.values()].filter((f) => f.status !== "invalidated").map((f) => ({
        sourceId: f.factId, kind: "fact", key: f.factId, statement: f.statement, source: f.source, sourceDigest: contentHash(f),
      })),
      ...[...entries.values()].filter((e) => e.status === "active" || e.status === "frozen").map((e) => ({
        sourceId: e.entryId, kind: "experience", key: e.entryId, statement: e.statement, source: e.provenance, sourceDigest: contentHash(e),
      })),
    ].map((source) => ({ ...source, sourceIdentity: this.identityValue.identityId }));
  }
  private async shareCandidate(body: Record<string, unknown>) {
    const sources = await this.localSources(await this.project(body["projectId"]));
    let input = body["input"] as Parameters<CollaborationService["share"]>[0];
    if (body["sourceId"] !== undefined) {
      const source = sources.find((s) => s.sourceId === body["sourceId"] && s.sourceDigest === body["sourceDigest"]);
      if (!source) throw new LocalRefusal("local sharing source digest changed");
      const { sourceId: _sourceId, ...selected } = source;
      input = selected;
    }
    return this.share(input, sources.map((s) => ({ id: s.sourceId, key: s.key, statement: s.statement })));
  }
  private async prepareDelegation(body: Record<string, unknown>) {
    if (this.delegations.size >= 128) throw new LocalRefusal("delegation session capacity exceeded; restart after stopping sessions");
    const project = await this.project(body["projectId"]); const paths = this.paths();
    const peer = this.peersValue.find((p) => p.identityId === body["recipientId"] && !p.revoked);
    if (!peer?.endpoint) throw new LocalRefusal("pin an unrevoked public peer with a declared endpoint first");
    if (body["endpoint"] !== undefined && body["endpoint"] !== peer.endpoint) throw new LocalRefusal("endpoint differs from pinned peer");
    if (!Array.isArray(body["scopePaths"]) || body["scopePaths"].length < 1 || body["scopePaths"].length > 64) throw new LocalRefusal("bounded child scope required");
    const scopePaths = body["scopePaths"].map((p) => portablePath(text(p, "child scope")));
    if (new Set(scopePaths).size !== scopePaths.length ||
        scopePaths.some((p) => /(^|\/)(\.git|\.env(?:\..*)?|credentials?|secrets?|.*\.(pem|key|p12))($|\/)/i.test(p))) {
      throw new LocalRefusal("credential/workspace metadata paths cannot be delegated");
    }
    const budget = body["budget"] as DelegationRequest["budget"];
    if (!budget || !Number.isInteger(budget.maxTokens) || budget.maxTokens < 0 || budget.maxTokens > 100000 ||
        !Number.isInteger(budget.maxBytes) || budget.maxBytes < 4096 || budget.maxBytes > 1024 * 1024 ||
        !Number.isInteger(budget.maxWallClockMs) || budget.maxWallClockMs < 100 || budget.maxWallClockMs > 60000) {
      throw new LocalRefusal("delegation budget must be explicit: 0-100000 tokens, 4096-1048576 bytes, 100-60000 ms");
    }
    if (body["parameters"] === undefined) throw new LocalRefusal("explicit public delegation parameters required");
    rejectSecrets(body["parameters"]);
    const delegationId = newId("delegation");
    const output = join(paths.artifactsDir);
    const session = await maintenanceSession(paths, project, { goal: "Observe explicitly bounded remote delegation without completion",
      resources: [output, `${output}/**`, ...scopePaths], endpoint: peer.endpoint,
      maxTokens: budget.maxTokens + 1, maxWallClockMs: budget.maxWallClockMs + 60000 });
    try {
      const request: DelegationRequest = {
        version: "keystone.delegation/1", operation: "delegate", requestId: newId("prop"), idempotencyKey: newId("prop"),
        taskId: session.taskId, requesterId: this.identityValue.identityId, recipientId: peer.identityId, endpoint: peer.endpoint,
        contractDigest: contentHash(session.contract()), environmentDigest: contentHash({ workspaceId: project.workspaceId, scopePaths }),
        conditionIds: session.contract()!.completionConditions.map((c) => c.conditionId), scopePaths, budget,
        parameters: body["parameters"] as DelegationRequest["parameters"], issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + budget.maxWallClockMs).toISOString(),
      };
      const signed = this.signer(request, delegationBinding(request, "delegation.request"));
      if (Buffer.byteLength(canonicalJson(signed)) > budget.maxBytes) throw new LocalRefusal("signed request exceeds byte budget");
      await localDecision(session, undefined, [peer.endpoint, ...scopePaths], { action: "prepare", request });
      const d: LocalDelegation = { delegationId, digest: contentHash(signed), signed, session, paths, project,
        controller: new AbortController(), queue: sessionQueue(), state: "prepared" };
      this.delegations.set(delegationId, d);
      return { delegationId, taskId: session.taskId, digest: d.digest, signed, networkAttempted: false };
    } catch (error) { await session.stop("delegation preparation refused"); throw error; }
  }
  private async admitDelegation(body: Record<string, unknown>) {
    const d = this.delegations.get(text(body["delegationId"], "delegation identity"));
    if (!d || d.state !== "prepared" || body["digest"] !== d.digest || d.paths.home !== this.paths().home) throw new LocalRefusal("prepared delegation digest/state changed");
    await this.project(d.project.projectId);
    const request = d.signed.document as DelegationRequest;
    const peer = this.peersValue.find((p) => p.identityId === request.recipientId && !p.revoked && p.endpoint === request.endpoint);
    if (!peer || Date.parse(request.expiresAt) <= Date.now()) throw new LocalRefusal("prepared delegation expired or peer revoked");
    d.state = "sending";
    return d;
  }
  private async sendDelegation(d: LocalDelegation) {
    const request = d.signed.document as DelegationRequest;
    const leases = new Map<string, CapabilityLease>();
    d.client = new DelegationClient({
      identityId: this.identityValue.identityId,
      peers: () => [{ ...this.identityValue, revoked: false }, ...this.peersValue], endpoints: [request.endpoint],
      hooks: {
        authorize: (operation) => d.queue(async () => {
          if (d.controller.signal.aborted || operation.taskId !== d.session.taskId || operation.parametersHash !== d.digest ||
              operation.endpoint !== request.endpoint || contentHash(operation.scopePaths) !== contentHash(request.scopePaths)) throw new LocalRefusal("delegation admission changed");
          const issued = [];
          for (const [capability, resources] of [["net.fetch", [operation.host]], ["external.write", [operation.endpoint]]] as const) {
            const ttl = Math.min(request.budget.maxWallClockMs, Date.parse(request.expiresAt) - Date.now());
            if (ttl <= 0) throw new LocalRefusal("delegation expiry reached");
            const decision = await localDecision(d.session, capability, resources, d.signed, ttl);
            const lease = await authorizedLease(d.session, capability, resources, operation.parametersHash, decision, ttl, operation.subjectId);
            leases.set(lease.leaseId, lease); issued.push(lease);
          }
          return issued;
        }),
        currentLease: async (id) => {
          if (d.controller.signal.aborted || d.session.state().status !== "executing" ||
              !this.peersValue.some((p) => p.identityId === request.recipientId && !p.revoked && p.endpoint === request.endpoint)) return undefined;
          let lease = leases.get(id);
          for (const event of d.session.events()) {
            if (event.payload["leaseId"] !== id || !lease) continue;
            if (event.type === "lease.consumed") lease = consumeLease(lease);
            if (event.type === "lease.revoked") lease = { ...lease, status: "revoked" };
          }
          return lease;
        },
        consume: (id) => d.queue(async () => {
          if (d.controller.signal.aborted) throw new LocalRefusal("delegation cancelled");
          await d.session.consumeExecutionLease(id);
        }),
        observeParent: (observation) => d.queue(async () => {
          if (d.controller.signal.aborted || d.session.state().status !== "executing") throw new LocalRefusal("parent observation fenced");
          const bytes = Buffer.from(canonicalJson(observation)); const digest = sha256Bytes(bytes);
          const file = join(d.paths.artifactsDir, digest.slice(0, 2), digest);
          const resources = [d.paths.artifactsDir, file];
          const parameters = { path: file, sha256: digest, bytes: bytes.length, sourceDigest: observation.sourceDigest, trustLevel: "untrusted" };
          const decision = await localDecision(d.session, "fs.write", resources, parameters);
          const lease = await authorizedLease(d.session, "fs.write", resources, contentHash(parameters), decision);
          await d.session.consumeExecutionLease(lease.leaseId);
          await assertStorePath(d.paths, file);
          await mkdir(join(d.paths.artifactsDir, digest.slice(0, 2)), { recursive: true });
          await writeFileAtomic(file, bytes);
          if (d.controller.signal.aborted) throw new LocalRefusal("parent observation fenced");
          await d.session.recordExecution({ proposalId: request.requestId, status: "succeeded",
            durationMs: 0, artifactId: `art_${digest}`, outputHash: digest, outputBytes: bytes.length, changedPaths: [file] });
          await d.session.recordBudget({ tokens: request.budget.maxTokens, wallClockMs: observation.claimed.usage.wallClockMs,
            reason: "Reserved child tokens; remote provider usage is not locally measured", measured: false });
          return { eventId: d.session.events().findLast((e) => e.type === "action.executed")!.eventId };
        }),
      },
    });
    const started = performance.now();
    const work = async () => {
      try {
        d.observation = await d.client!.delegate(d.signed, d.controller.signal); d.state = "observed";
        return { delegationId: d.delegationId, taskId: d.session.taskId, observation: d.observation };
      } catch (error) {
        if (!d.controller.signal.aborted) d.state = "failed";
        throw error;
      } finally {
        await d.queue(async () => {
          if (d.session.state().status !== "stopped") {
            await d.session.recordBudget({ wallClockMs: Math.ceil(performance.now() - started),
              reason: "Measured local delegation transport duration" });
            await d.session.stop("delegation ended; imported observations are not Proof");
          }
        });
      }
    };
    d.pending = work();
    return await d.pending;
  }
  private async stopDelegation(d: LocalDelegation) {
    d.controller.abort();
    await d.queue(async () => {
      if (d.session.state().status !== "stopped") await d.session.stop("user stopped local delegation");
      if (d.state !== "observed") d.state = "stopped";
    });
    return { delegationId: d.delegationId, taskId: d.session.taskId, status: d.state };
  }
  async dispose() {
    this.disposed = true;
    for (const d of this.delegations.values()) await this.stopDelegation(d);
    await Promise.allSettled([...this.delegations.values()].map((d) => d.pending));
  }
  override async handle(method: string, path: string, body?: unknown, context?: LocalUiContext): Promise<{ status: number; body: any }> {
    try {
      if (this.disposed) throw new LocalRefusal("local collaboration session closed", 503);
      const admitted = <T>(work: () => Promise<T>): Promise<T> => this.mutateQueue(async () => {
        if (this.disposed) throw new LocalRefusal("local collaboration session closed", 503);
        await this.refreshPeers();
        return work();
      });
      if (method === "GET" && path === "/v1/collaboration") return { status: 200,
        body: await admitted(async () => ({ ...this.status(), projects: await this.local.projects() })) };
      const sourceProject = /^\/v1\/collaboration\/sources\/([^/]+)$/.exec(path);
      if (method === "GET" && sourceProject) return { status: 200, body: await admitted(async () => ({
        sources: await this.localSources(await this.project(decodeURIComponent(sourceProject[1]!))),
      })) };
      if (method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)) return { status: 404, body: { error: "not_found" } };
      rejectSecrets(body);
      const input = body as Record<string, unknown>;
      if (path.endsWith("/preview") || path.endsWith("/verify")) return await admitted(() => super.handle(method, path, body));
      confirm(input, context);
      const action = async () => {
        switch (path) {
          case "/v1/collaboration/initialize": return this.initialize(input);
          case "/v1/collaboration/peers/register": return this.peerAction(input, false);
          case "/v1/collaboration/peers/revoke": return this.peerAction(input, true);
          case "/v1/collaboration/export": return this.exportTask(input);
          case "/v1/collaboration/import": return this.quarantine(input);
          case "/v1/collaboration/adopt-task": return this.adoptTask(input);
          case "/v1/collaboration/share": return this.shareCandidate(input);
          case "/v1/collaboration/adopt": throw new LocalRefusal("Trust-preserving project fact/experience promotion is unavailable; candidates remain untrusted", 501);
          case "/v1/collaboration/delegation/prepare": return this.prepareDelegation(input);
          default: throw new LocalRefusal("unsupported local collaboration action", 404);
        }
      };
      if (path === "/v1/collaboration/delegate") {
        const delegation = await admitted(() => this.admitDelegation(input));
        return { status: 200, body: await this.sendDelegation(delegation) };
      }
      if (path === "/v1/collaboration/delegation/stop") {
        return { status: 200, body: await admitted(async () => {
          const d = this.delegations.get(text(input["delegationId"], "delegation identity"));
          if (!d) throw new LocalRefusal("local delegation not found");
          return this.stopDelegation(d);
        }) };
      }
      return { status: 200, body: await admitted(action) };
    } catch (error) {
      const status = error instanceof LocalRefusal ? error.status : 400;
      const reason = error instanceof LocalRefusal || (error instanceof Error && /capsule|secret/.test(error.message))
        ? error.message : "Local collaboration validation, integrity or lease check rejected the action.";
      return { status, body: { error: "collaboration_request_rejected", reason } };
    }
  }
}
