import { validateLease } from "@keystone/kernel";
import {
  arrayOf, canonicalJson, contentHash, defineSchema, enumOf, int, jsonValue, lit, nonEmptyStr,
  objectOf, optional, str, type CapabilityLease, type InferSchema,
} from "@keystone/schemas";
import { portablePath } from "./bundles.ts";
import { rejectSecrets, signDocument, verifyDocument, type PeerIdentity, type SignatureBinding, type SignedDocument } from "./signatures.ts";

export const DELEGATION_VERSION = "keystone.delegation/1" as const;
const budgetValidator = objectOf({
  maxTokens: int({ min: 0, max: 1_000_000 }), maxBytes: int({ min: 1, max: 1024 * 1024 }),
  maxWallClockMs: int({ min: 1, max: 300_000 }),
});
const digestValidator = str({ pattern: /^[0-9a-f]{64}$/ });
const requestSchema = defineSchema("keystone.collaboration.delegationRequest", "1.0.0", objectOf({
  version: lit(DELEGATION_VERSION), operation: enumOf(["delegate", "cancel"] as const),
  requestId: nonEmptyStr(), idempotencyKey: nonEmptyStr(), taskId: nonEmptyStr(),
  requesterId: nonEmptyStr(), recipientId: nonEmptyStr(), endpoint: str({ maxLength: 2048 }),
  contractDigest: digestValidator, environmentDigest: digestValidator,
  conditionIds: arrayOf(nonEmptyStr(), { maxItems: 256 }),
  scopePaths: arrayOf(nonEmptyStr(), { minItems: 1, maxItems: 64 }), budget: budgetValidator,
  parameters: jsonValue(), issuedAt: nonEmptyStr(), expiresAt: nonEmptyStr(), cancelsRequestId: optional(nonEmptyStr()),
}));
export type DelegationRequest = InferSchema<typeof requestSchema>;
const resultSchema = defineSchema("keystone.collaboration.delegationResult", "1.0.0", objectOf({
  version: lit(DELEGATION_VERSION), requestId: nonEmptyStr(), requestDigest: digestValidator,
  taskId: nonEmptyStr(), environmentDigest: digestValidator,
  status: enumOf(["observed", "failed", "cancelled"] as const), observation: jsonValue(),
  usage: objectOf({ tokens: int({ min: 0 }), wallClockMs: int({ min: 0 }) }),
}));
export type DelegationResult = InferSchema<typeof resultSchema>;
export interface RemoteObservation {
  readonly requestId: string; readonly sourceIdentity: string; readonly sourceDigest: string;
  readonly trustLevel: "untrusted"; readonly authority: "imported_candidate"; readonly claimed: DelegationResult;
}
export function delegationBinding(request: DelegationRequest, purpose: string): SignatureBinding {
  return { purpose, taskId: request.taskId, contractDigest: request.contractDigest,
    conditionIds: request.conditionIds, environmentDigest: request.environmentDigest,
    issuedAt: request.issuedAt, expiresAt: request.expiresAt };
}
function expected(request: DelegationRequest, purpose: string) {
  const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...binding } = delegationBinding(request, purpose);
  return binding;
}
function parseRequest(signed: SignedDocument): DelegationRequest {
  rejectSecrets(signed);
  const request = requestSchema.parse(signed.document);
  for (const path of request.scopePaths) portablePath(path);
  if (new Set(request.scopePaths).size !== request.scopePaths.length) throw new Error("duplicate scope path");
  if ((request.operation === "cancel") !== (request.cancelsRequestId !== undefined)) throw new Error("cancel target required");
  const url = new URL(request.endpoint);
  if (url.username || url.password || url.hash || url.search ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("endpoint must be declared HTTPS or literal loopback HTTP without credentials");
  }
  return request;
}
function checkSignature(signed: SignedDocument, request: DelegationRequest, peers: readonly PeerIdentity[], now: Date, purpose: string) {
  if (!verifyDocument(signed, { peers, expected: expected(request, purpose), now }).ok) throw new Error("signature or expiry rejected");
}

export interface OutboundOperation {
  readonly taskId: string; readonly subjectId: string; readonly endpoint: string; readonly host: string;
  readonly parametersHash: string; readonly operation: "delegate" | "cancel";
  readonly budget: DelegationRequest["budget"]; readonly scopePaths: readonly string[]; readonly expiresAt: string;
}
/** Injected by the parent owning the active KernelSession, never supplied by HTTP request data. */
export interface OutboundHooks {
  readonly authorize: (operation: OutboundOperation) => Promise<readonly CapabilityLease[]>;
  readonly currentLease: (leaseId: string) => Promise<CapabilityLease | undefined>;
  readonly consume: (leaseId: string) => Promise<void>;
  readonly observeParent: (observation: RemoteObservation) => Promise<{ eventId: string }>;
}
export interface DelegationClientOptions {
  readonly identityId: string; readonly peers: () => readonly PeerIdentity[]; readonly endpoints: readonly string[];
  readonly hooks?: OutboundHooks; readonly now?: () => Date;
}
interface CachedCall { digest: string; expiresAt: number; promise: Promise<RemoteObservation> }

export class DelegationClient {
  private readonly options: DelegationClientOptions;
  private readonly calls = new Map<string, CachedCall>();
  constructor(options: DelegationClientOptions) { this.options = options; }
  delegate(signed: SignedDocument, signal?: AbortSignal) { return this.send(signed, "delegate", signal); }
  cancel(signed: SignedDocument, signal?: AbortSignal) { return this.send(signed, "cancel", signal); }
  status() { return { version: DELEGATION_VERSION, requests: this.calls.size, outboundAvailable: this.options.hooks !== undefined }; }

  private async send(input: SignedDocument, operation: "delegate" | "cancel", signal?: AbortSignal): Promise<RemoteObservation> {
    const signed = structuredClone(input);
    const request = parseRequest(signed);
    const now = this.options.now?.() ?? new Date();
    if (signal?.aborted) throw new Error("delegation cancelled");
    if (request.operation !== operation || request.requesterId !== this.options.identityId ||
        signed.envelope.identityId !== request.requesterId) throw new Error("request identity or operation rejected");
    const peers = this.options.peers();
    if (!peers.some((peer) => peer.identityId === request.recipientId && !peer.revoked)) throw new Error("recipient identity revoked or unknown");
    checkSignature(signed, request, peers, now, "delegation.request");
    if (!this.options.endpoints.includes(request.endpoint)) throw new Error("endpoint not declared");
    if (this.options.hooks === undefined) throw new Error("parent capability lease hook required");
    const hash = contentHash(request);
    const key = `${request.taskId}\0${request.requesterId}\0${request.idempotencyKey}`;
    for (const [id, call] of this.calls) if (call.expiresAt <= now.getTime()) this.calls.delete(id);
    const previous = this.calls.get(key);
    if (previous !== undefined) {
      if (previous.digest !== hash) throw new Error("idempotency replay mismatch");
      return structuredClone(await previous.promise);
    }
    if (this.calls.size >= 1024) throw new Error("idempotency capacity exceeded");
    const promise = this.outbound(signed, request, signal);
    this.calls.set(key, { digest: hash, expiresAt: Date.parse(request.expiresAt), promise });
    return structuredClone(await promise);
  }

  private async outbound(signed: SignedDocument, request: DelegationRequest, callerSignal?: AbortSignal): Promise<RemoteObservation> {
    const hooks = this.options.hooks!;
    const payload = canonicalJson(signed);
    if (Buffer.byteLength(payload) > request.budget.maxBytes) throw new Error("request byte budget exceeded");
    const operation: OutboundOperation = {
      taskId: request.taskId, subjectId: request.requesterId, endpoint: request.endpoint,
      host: new URL(request.endpoint).hostname, parametersHash: contentHash(signed), operation: request.operation,
      budget: request.budget, scopePaths: request.scopePaths, expiresAt: request.expiresAt,
    };
    const leases = await hooks.authorize(operation);
    if (leases.length !== 2) throw new Error("network and external write leases required");
    const time = () => this.options.now?.() ?? new Date();
    const checkLeases = async (after = false) => {
      for (const capability of ["net.fetch", "external.write"] as const) {
        const issued = leases.find((lease) => lease.capability === capability);
        const lease = issued === undefined ? undefined : await hooks.currentLease(issued.leaseId);
        if (issued?.constraints.parametersHash !== operation.parametersHash ||
            lease === undefined || lease.taskId !== request.taskId || lease.subject.id !== request.requesterId ||
            lease.constraints.parametersHash !== operation.parametersHash ||
            lease.subject.kind !== "orchestrator" || lease.issuedBy !== "kernel" ||
            lease.expiresAt !== issued.expiresAt || lease.scopeDigest !== issued.scopeDigest ||
            lease.leaseId !== issued?.leaseId || lease.capability !== capability ||
            lease.resource.values.length !== 1 || lease.resource.values[0] !== (capability === "net.fetch" ? operation.host : operation.endpoint) ||
            lease.status === "revoked" || Date.parse(lease.expiresAt) <= time().getTime()) throw new Error("lease binding or revocation rejected");
        if (!after && !validateLease(lease, { capability, resourceValues: lease.resource.values,
          parametersHash: operation.parametersHash, now: time() }).ok) throw new Error("lease rejected");
      }
    };
    await checkLeases();
    const remaining = Date.parse(request.expiresAt) - time().getTime();
    if (remaining <= 0 || callerSignal?.aborted) throw new Error("delegation cancelled or expiry reached");
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, request.budget.maxWallClockMs)));
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([timeout, callerSignal]);
    const started = performance.now();
    for (const lease of leases) await hooks.consume(lease.leaseId);
    await checkLeases(true);
    if (signal.aborted) throw new Error("delegation cancelled");
    let response: Response;
    let bytes: Buffer;
    try {
      response = await fetch(request.endpoint, { method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", "x-keystone-delegation-version": DELEGATION_VERSION }, body: payload });
      if (!response.ok || response.body === null) throw new Error("response status rejected");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > request.budget.maxBytes) { await response.body.cancel().catch(() => undefined); throw new Error("response byte budget exceeded"); }
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof Error && /response|budget/.test(error.message)) throw error;
      throw new Error(signal.aborted ? "delegation cancelled or timeout" : "delegation network failure");
    }
    await checkLeases(true);
    if (signal.aborted || performance.now() - started > request.budget.maxWallClockMs) throw new Error("response budget exceeded");
    let resultSigned: SignedDocument;
    let result: DelegationResult;
    try {
      resultSigned = JSON.parse(bytes.toString("utf8")) as SignedDocument;
      checkSignature(resultSigned, request, this.options.peers(), time(), "delegation.result");
      if (resultSigned.envelope.identityId !== request.recipientId) throw new Error("wrong identity");
      result = resultSchema.parse(resultSigned.document);
      if (result.requestId !== request.requestId || result.requestDigest !== contentHash(request) ||
          result.taskId !== request.taskId || result.environmentDigest !== request.environmentDigest ||
          result.usage.tokens > request.budget.maxTokens || result.usage.wallClockMs > request.budget.maxWallClockMs ||
          Date.parse(resultSigned.envelope.binding.expiresAt) > Date.parse(request.expiresAt)) throw new Error("binding or budget mismatch");
    } catch { throw new Error("response signature, binding or budget rejected"); }
    const observation: RemoteObservation = {
      requestId: request.requestId, sourceIdentity: request.recipientId, sourceDigest: contentHash(resultSigned),
      trustLevel: "untrusted", authority: "imported_candidate", claimed: result,
    };
    const receipt = await hooks.observeParent(structuredClone(observation));
    if (!receipt.eventId) throw new Error("parent observation event required");
    return observation;
  }
}

export interface DelegationReceiverOptions {
  readonly identityId: string; readonly endpoint: string; readonly peers: () => readonly PeerIdentity[];
  readonly scopePaths: readonly string[]; readonly maxBudget: DelegationRequest["budget"];
  readonly admit?: (request: DelegationRequest, signal: AbortSignal) => Promise<{ observation: unknown; usage: { tokens: number } }>;
  readonly sign: (document: unknown, binding: SignatureBinding) => ReturnType<typeof signDocument>;
  readonly now?: () => Date;
}
interface ReceivingCall extends CachedCall { requestId: string; controller: AbortController; signed: Promise<SignedDocument> }
export class DelegationReceiver {
  private readonly options: DelegationReceiverOptions;
  private readonly calls = new Map<string, Omit<ReceivingCall, "promise">>();
  constructor(options: DelegationReceiverOptions) { this.options = options; }
  async receive(signed: SignedDocument): Promise<SignedDocument> {
    const request = parseRequest(signed);
    const now = this.options.now?.() ?? new Date();
    checkSignature(signed, request, this.options.peers(), now, "delegation.request");
    if (signed.envelope.identityId !== request.requesterId || request.recipientId !== this.options.identityId ||
        request.endpoint !== this.options.endpoint) throw new Error("receiver identity binding rejected");
    if (request.scopePaths.some((path) => !this.options.scopePaths.includes(path)) ||
        Object.entries(request.budget).some(([key, value]) => value > this.options.maxBudget[key as keyof DelegationRequest["budget"]])) {
      throw new Error("receiver scope or budget rejected");
    }
    if (this.options.admit === undefined) throw new Error("child kernel admission required");
    for (const [id, call] of this.calls) if (call.expiresAt <= now.getTime()) { call.controller.abort(); this.calls.delete(id); }
    const key = `${request.taskId}\0${request.requesterId}\0${request.idempotencyKey}`;
    const digest = contentHash(request);
    const previous = this.calls.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error("idempotency replay rejected");
      return structuredClone(await previous.signed);
    }
    if (this.calls.size >= 1024 || [...this.calls.values()].some((call) => call.requestId === request.requestId)) {
      throw new Error("request replay or capacity rejected");
    }
    const controller = new AbortController();
    const promise = this.execute(request, controller);
    this.calls.set(key, { digest, requestId: request.requestId, controller,
      expiresAt: Date.parse(request.expiresAt), signed: promise });
    return structuredClone(await promise);
  }
  private async execute(request: DelegationRequest, controller: AbortController): Promise<SignedDocument> {
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), Math.min(request.budget.maxWallClockMs,
      Math.max(1, Date.parse(request.expiresAt) - (this.options.now?.() ?? new Date()).getTime())));
    let observation: unknown = null;
    let tokens = 0;
    let status: DelegationResult["status"] = "observed";
    try {
      if (request.operation === "cancel") {
        const target = [...this.calls.entries()].find(([key, call]) =>
          key.startsWith(`${request.taskId}\0${request.requesterId}\0`) && call.requestId === request.cancelsRequestId);
        if (target === undefined) throw new Error("unknown cancel target");
        target[1].controller.abort();
        status = "cancelled";
      } else {
        const returned = await Promise.race([
          this.options.admit!(structuredClone(request), controller.signal),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort",
            () => reject(new Error("child cancelled")), { once: true })),
        ]);
        observation = returned.observation;
        tokens = returned.usage.tokens;
        rejectSecrets(observation);
        if (tokens > request.budget.maxTokens) throw new Error("child token budget exceeded");
        if (controller.signal.aborted) { status = "cancelled"; observation = null; }
      }
    } catch { status = controller.signal.aborted ? "cancelled" : "failed"; observation = null; tokens = 0; }
    finally { clearTimeout(timer); }
    const result = resultSchema.parse({
      version: DELEGATION_VERSION, requestId: request.requestId, requestDigest: contentHash(request),
      taskId: request.taskId, environmentDigest: request.environmentDigest, status, observation,
      usage: { tokens, wallClockMs: Math.ceil(performance.now() - started) },
    });
    return this.options.sign(result, delegationBinding(request, "delegation.result"));
  }
}
