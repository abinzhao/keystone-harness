import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { contentHash } from "@keystone/schemas";
import { inside, previewBundle, type BundlePreview } from "./bundles.ts";
import { importCandidate, type ImportedCandidate, type LocalStatement } from "./candidates.ts";
import { DelegationClient } from "./delegation.ts";
import { rejectSecrets, verifyDocument, type ExpectedBinding, type PeerIdentity, type SharedInput, type SignedDocument } from "./signatures.ts";

export interface CollaborationAdmission {
  /** Parent must bind the destination+digest+decision and write only via kernel admission. */
  readonly importBundle?: (input: {
    bundle: BundlePreview; destination: string; decisionId: string;
  }) => Promise<{ eventId: string; destination: string }>;
  /** Parent validates a recorded local user decision and preserves upstream provenance. */
  readonly adoptCandidate?: (input: {
    candidate: ImportedCandidate; decisionId: string; resolveConflicts: readonly string[];
  }) => Promise<{ eventId: string }>;
}
export interface CollaborationServiceOptions {
  readonly peers: () => readonly PeerIdentity[];
  readonly bundleRoots?: readonly string[];
  readonly importRoots?: readonly string[];
  readonly admission?: CollaborationAdmission;
  readonly delegation?: DelegationClient;
  readonly now?: () => Date;
}
export interface ImportRequest { root: string; digest: string; destination: string; decisionId: string }

/** A projection/API facade, not an authoritative store or HTTP authentication layer. */
export class CollaborationService {
  private readonly options: CollaborationServiceOptions;
  private readonly candidates = new Map<string, ImportedCandidate>();
  constructor(options: CollaborationServiceOptions) { this.options = options; }

  status() {
    return {
      version: "keystone.collaboration/1", externalCompatibility: "local-fixture-only",
      signatures: "Ed25519 integrity only", portableBundles: "read-only validation",
      importAvailable: this.options.admission?.importBundle !== undefined,
      adoptionAvailable: this.options.admission?.adoptCandidate !== undefined,
      delegation: this.options.delegation?.status() ?? { outboundAvailable: false },
      candidates: [...this.candidates.values()].map((value) => structuredClone(value)),
      limits: ["No credential retention.", "No trust elevation.", "Parent kernel decides completion."],
    };
  }
  verify(input: { signed: unknown; expected: ExpectedBinding }) {
    return verifyDocument(input.signed, { peers: this.options.peers(), expected: input.expected, now: this.options.now?.() });
  }
  async preview(input: { root: string }): Promise<BundlePreview> {
    const root = await realpath(input.root);
    const allowed = await Promise.all((this.options.bundleRoots ?? []).map((path) => realpath(path)));
    if (!allowed.some((path) => inside(path, root))) throw new Error("bundle root not admitted");
    return previewBundle(root);
  }
  async importBundle(input: ImportRequest) {
    const admit = this.options.admission?.importBundle;
    if (admit === undefined) throw new Error("parent kernel import admission required");
    const bundle = await this.preview(input);
    if (bundle.digest !== input.digest) throw new Error("preview digest changed");
    const requested = resolve(input.destination);
    const roots = await Promise.all((this.options.importRoots ?? []).map(async (path) => ({
      declared: resolve(path), canonical: await realpath(path),
    })));
    const root = roots.find((entry) => inside(entry.declared, requested) && requested !== entry.declared);
    if (root === undefined) throw new Error("import destination not admitted");
    const expected = resolve(root.canonical, relative(root.declared, requested));
    const parent = await realpath(dirname(requested));
    const destination = join(parent, basename(requested));
    if (destination !== expected) throw new Error("destination symlink rejected");
    if (inside(bundle.root, destination)) throw new Error("import destination not admitted");
    try {
      await lstat(destination);
      throw new Error("import destination already exists");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!input.decisionId) throw new Error("recorded local decision required");
    const result = await admit({ bundle: structuredClone(bundle), destination, decisionId: input.decisionId });
    if (!result.eventId || result.destination !== destination) throw new Error("invalid parent import admission receipt");
    return { ...result, authority: "imported_candidate" as const };
  }
  share(input: SharedInput, local: readonly LocalStatement[]) {
    const candidate = importCandidate(input, local);
    this.candidates.set(candidate.candidateId, structuredClone(candidate));
    return candidate;
  }
  async adopt(input: { candidateId: string; digest: string; decisionId: string; resolveConflicts: readonly string[] }) {
    const admit = this.options.admission?.adoptCandidate;
    if (admit === undefined) throw new Error("parent kernel adoption admission required");
    const candidate = this.candidates.get(input.candidateId);
    if (candidate === undefined || contentHash(candidate) !== input.digest) throw new Error("candidate digest mismatch");
    if (!input.decisionId || contentHash([...input.resolveConflicts].sort()) !== contentHash([...candidate.conflicts].sort())) {
      throw new Error("explicit local decision and conflict resolution required");
    }
    const result = await admit({ candidate: structuredClone(candidate), decisionId: input.decisionId,
      resolveConflicts: [...input.resolveConflicts] });
    if (!result.eventId) throw new Error("kernel adoption event receipt required");
    // Imported candidate never becomes confirmed in this cache. The parent owns the new local record.
    return { ...result, candidateId: candidate.candidateId, status: "local_adoption_requested" as const };
  }
  async handle(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    try {
      if (method === "GET" && path === "/v1/collaboration") return { status: 200, body: this.status() };
      if (method !== "POST") return { status: 404, body: { error: "not_found" } };
      if (body === null || typeof body !== "object") return { status: 400, body: { error: "invalid_request" } };
      rejectSecrets(body);
      switch (path) {
        case "/v1/collaboration/verify": return { status: 200, body: this.verify(body as Parameters<CollaborationService["verify"]>[0]) };
        case "/v1/collaboration/preview": return { status: 200, body: await this.preview(body as { root: string }) };
        case "/v1/collaboration/import": return { status: 200, body: await this.importBundle(body as ImportRequest) };
        case "/v1/collaboration/adopt": return { status: 200, body: await this.adopt(body as Parameters<CollaborationService["adopt"]>[0]) };
        case "/v1/collaboration/delegate":
        case "/v1/collaboration/cancel": {
          const client = this.options.delegation;
          if (client === undefined) throw new Error("parent outbound lease hook required");
          const input = body as { signed: SignedDocument };
          return { status: 200, body: path.endsWith("/cancel")
            ? await client.cancel(input.signed) : await client.delegate(input.signed) };
        }
        default: return { status: 404, body: { error: "not_found" } };
      }
    } catch { return { status: 400, body: { error: "collaboration_request_rejected" } }; }
  }
}
