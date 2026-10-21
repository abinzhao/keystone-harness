import {
  canonicalJson, userDecisionSchema,
  type ExtensionManifest, type ExtensionRegistration, type UserDecision,
} from "@keystone/schemas";
import {
  LocalPackageError, prepareLocalInstall, probeLocalInstall,
  type LocalProbeApproval, type PreparedLocalInstall,
} from "./manager.ts";
import { reachesOutside } from "./activation.ts";
import { resolve } from "node:path";
import {
  ExtensionRegistry, type ExtensionHistoryEntry, type RegistryLocation,
} from "./registry.ts";

export type ExtensionDecisionAction = "probe" | "activate";

/** The parent authenticates user intent; this string binds it to actual bytes. */
export function extensionDecisionResource(manifest: ExtensionManifest, reviewHash: string,
  action: ExtensionDecisionAction): string {
  return `extension:${manifest.name}@${manifest.version}:${reviewHash}:${action}`;
}

function requireDecision(manifest: ExtensionManifest, reviewHash: string,
  action: ExtensionDecisionAction, raw: UserDecision): UserDecision {
  const decision = userDecisionSchema.parse(raw) as UserDecision;
  if (decision.decision !== "allow" || decision.recordedBy !== "user" ||
      (decision.appliesTo.capability !== undefined && decision.appliesTo.capability !== "extension.activate") ||
      !decision.appliesTo.resources.includes(extensionDecisionResource(manifest, reviewHash, action)) ||
      (decision.appliesTo.expiresAt !== undefined && Date.parse(decision.appliesTo.expiresAt) <= Date.now())) {
    throw new LocalPackageError("a live explicit user decision bound to this version, review hash and action is required");
  }
  return decision;
}

export interface ExtensionUpgradeDiff {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly previousReviewHash?: string;
  readonly changedFiles: readonly string[];
  readonly addedCapabilities: readonly string[];
  readonly removedCapabilities: readonly string[];
  readonly permissionsChanged: boolean;
  readonly before: ExtensionManifest;
  readonly after: ExtensionManifest;
}

export interface ExtensionReview extends PreparedLocalInstall {
  readonly blockers: readonly string[];
  readonly upgrade?: ExtensionUpgradeDiff;
}

export interface ExtensionLifecycleView extends ExtensionRegistration {
  readonly reviewHash?: string;
  readonly lifecycleStatus: ExtensionRegistration["status"] | "uninstalled";
  readonly history: readonly ExtensionHistoryEntry[];
}

export interface ExtensionActivationInput {
  readonly reviewHash: string;
  readonly decision?: UserDecision;
}

function permissionDeclaration(manifest: ExtensionManifest): string {
  return canonicalJson({
    capabilities: [...manifest.capabilities].sort(), sideEffects: manifest.sideEffects,
    egressHosts: [...manifest.egressHosts].sort(), credentialHandles: [...manifest.credentialHandles].sort(),
    dataClassification: manifest.dataClassification, reversibility: manifest.reversibility,
    transport: manifest.transport ?? null,
  });
}

/**
 * HTTP-facing local service. Registry mutations are projections, never task
 * authority. Decisions must originate at the parent's authenticated UI boundary.
 */
export class ExtensionLifecycleService {
  readonly registry: ExtensionRegistry;
  private readonly listeners = new Set<(name: string) => void>();

  constructor(location: RegistryLocation) {
    this.registry = new ExtensionRegistry(location);
  }

  /** Host cancellation hooks; notification carries no permission or task state. */
  onUnavailable(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private unavailable(name: string): void {
    for (const listener of this.listeners) listener(name);
  }

  async list(): Promise<readonly ExtensionLifecycleView[]> {
    await this.registry.load();
    return this.registry.list().map((registration) => {
      const metadata = this.registry.metadata(registration.manifest.name);
      return {
        ...registration,
        ...(metadata.reviewHash === undefined ? {} : { reviewHash: metadata.reviewHash }),
        lifecycleStatus: metadata.removedAt === undefined ? registration.status : "uninstalled",
        history: metadata.history,
      };
    });
  }

  async review(directory: string): Promise<ExtensionReview> {
    const prepared = await prepareLocalInstall(directory);
    await this.registry.load();
    const blockers = prepared.conformance.checks
      .filter((check) => check.blocking && !check.passed && check.checkId !== "execution.consent" &&
        !(check.checkId === "manifest.integrity" && prepared.read.integrityBasis === "local_path_trust"))
      .map((check) => `${check.checkId}: ${check.detail}`);
    try { this.registry.assertDependencies(prepared.read.manifest); }
    catch (error) { blockers.push(error instanceof Error ? error.message : "dependencies cannot be resolved"); }
    const previous = this.registry.get(prepared.read.manifest.name);
    const metadata = this.registry.metadata(prepared.read.manifest.name);
    let upgrade: ExtensionUpgradeDiff | undefined;
    if (previous !== undefined && metadata.reviewHash !== prepared.reviewHash) {
      const beforeFiles = new Map(metadata.files.map((file) => [file.path, `${file.digest}:${file.mode}`]));
      const afterFiles = new Map(prepared.files.map((file) => [file.path, `${file.digest}:${file.mode}`]));
      upgrade = {
        fromVersion: previous.manifest.version, toVersion: prepared.read.manifest.version,
        ...(metadata.reviewHash === undefined ? {} : { previousReviewHash: metadata.reviewHash }),
        changedFiles: [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
          .filter((path) => beforeFiles.get(path) !== afterFiles.get(path)).sort(),
        addedCapabilities: prepared.read.manifest.capabilities.filter((cap) => !previous.manifest.capabilities.includes(cap)),
        removedCapabilities: previous.manifest.capabilities.filter((cap) => !prepared.read.manifest.capabilities.includes(cap)),
        permissionsChanged: permissionDeclaration(previous.manifest) !== permissionDeclaration(prepared.read.manifest),
        before: previous.manifest, after: prepared.read.manifest,
      };
    }
    return { ...prepared, blockers, ...(upgrade === undefined ? {} : { upgrade }) };
  }

  async install(directory: string, reviewHash: string, confirmed: boolean): Promise<ExtensionRegistration> {
    if (confirmed !== true) throw new LocalPackageError("explicit install confirmation is required");
    const reviewed = await this.review(directory);
    if (reviewed.reviewHash !== reviewHash) throw new LocalPackageError("package changed since review; review hash does not match");
    if (reviewed.blockers.length > 0) throw new LocalPackageError(reviewed.blockers.join("; "));
    const entry = await this.registry.register({
      manifest: reviewed.read.manifest, source: { kind: "local_path", locator: resolve(directory) },
      integrityVerified: reviewed.read.integrityVerified, conformance: reviewed.conformance,
      reviewHash, files: reviewed.files, checkDependencies: true,
    });
    this.unavailable(entry.manifest.name);
    return entry;
  }

  private async installed(name: string, reviewHash?: string): Promise<ExtensionRegistration> {
    await this.registry.load();
    const entry = this.registry.get(name);
    const metadata = this.registry.metadata(name);
    if (entry === undefined) throw new LocalPackageError(`extension "${name}" is not installed`);
    if (metadata.removedAt !== undefined) throw new LocalPackageError(`extension "${name}" is uninstalled`);
    if (metadata.reviewHash === undefined || (reviewHash !== undefined && metadata.reviewHash !== reviewHash)) {
      throw new LocalPackageError("installed review hash is missing or changed; review again");
    }
    return entry;
  }

  private async verifyInstalled(name: string, reviewHash: string): Promise<ExtensionRegistration> {
    const entry = await this.installed(name, reviewHash);
    let current: PreparedLocalInstall;
    try { current = await prepareLocalInstall(entry.source.locator); }
    catch {
      await this.registry.isolate(name, "integrity_failure", "installed package cannot be read", reviewHash);
      this.unavailable(name);
      throw new LocalPackageError("installed package integrity cannot be verified");
    }
    if (current.reviewHash !== reviewHash || !current.staticChecksPassed) {
      await this.registry.isolate(name, "integrity_failure", "package changed after review", reviewHash);
      this.unavailable(name);
      throw new LocalPackageError("installed package integrity changed after review");
    }
    return this.installed(name, reviewHash);
  }

  async probe(name: string, input: LocalProbeApproval): Promise<PreparedLocalInstall> {
    const entry = await this.verifyInstalled(name, input.reviewHash);
    if (entry.status !== "registered") throw new LocalPackageError("probe requires a registered extension; reinstall after disable");
    const decision = requireDecision(entry.manifest, input.reviewHash, "probe", input.decision);
    const controller = new AbortController();
    const detach = this.onUnavailable((changed) => { if (changed === name) controller.abort(); });
    let probed: PreparedLocalInstall;
    try {
      probed = await probeLocalInstall(entry.source.locator, { ...input, decision,
        signal: AbortSignal.any([controller.signal, ...(input.signal === undefined ? [] : [input.signal])]),
      });
    } finally { detach(); }
    // Do not persist a successful observation for changed live files.
    await this.verifyInstalled(name, input.reviewHash);
    requireDecision(entry.manifest, input.reviewHash, "probe", decision);
    await this.registry.recordProbe(name, input.reviewHash, probed.conformance,
      probed.read.integrityVerified, decision.decisionId);
    return probed;
  }

  async activate(name: string, input: ExtensionActivationInput): Promise<ExtensionRegistration> {
    const entry = await this.verifyInstalled(name, input.reviewHash);
    const decision = input.decision === undefined ? undefined
      : requireDecision(entry.manifest, input.reviewHash, "activate", input.decision);
    if ((reachesOutside(entry.manifest) || entry.manifest.capabilities.includes("cmd.exec") ||
        entry.manifest.reversibility === "irreversible") && decision === undefined) {
      throw new LocalPackageError("activation requires an explicit version/hash-bound user decision");
    }
    return this.registry.activate(name, { reviewHash: input.reviewHash, ...(decision === undefined ? {} : { decision }) });
  }

  async assertUsable(name: string, reviewHash: string): Promise<ExtensionRegistration> {
    const entry = await this.verifyInstalled(name, reviewHash);
    if (entry.status !== "active") throw new LocalPackageError(`extension "${name}" is not active`);
    this.registry.assertDependencies(entry.manifest, true);
    return entry;
  }

  async disable(name: string): Promise<ExtensionRegistration> {
    const result = await this.registry.disable(name);
    this.unavailable(name);
    return result;
  }

  async uninstall(name: string): Promise<ExtensionRegistration> {
    const result = await this.registry.uninstall(name);
    this.unavailable(name);
    return result;
  }

  /**
   * History is metadata, not a hidden backup of user code. Rollback is possible
   * only while that version's original source still matches its reviewed bytes.
   */
  async rollback(name: string, reviewHash: string, confirmed: boolean): Promise<ExtensionRegistration> {
    if (confirmed !== true) throw new LocalPackageError("explicit rollback confirmation is required");
    await this.registry.load();
    const previous = this.registry.metadata(name).history.findLast((item) => item.reviewHash === reviewHash);
    if (previous === undefined) throw new LocalPackageError("rollback review hash is not in retained history");
    return this.install(previous.registration.source.locator, reviewHash, true);
  }
}
