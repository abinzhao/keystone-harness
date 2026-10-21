/**
 * Extension registry.
 *
 * The registry is *derived* data: it records what was installed, what the
 * conformance run found, and why an extension was isolated. It is not the source
 * of truth for anything a task depends on — so it is stored as a single atomic
 * JSON document rather than as part of the task ledger (ADR-0005).
 *
 * Every state change is written to disk before it is reported, because "the UI
 * says the extension is isolated" must survive a crash.
 */

import {
  extensionRegistrationSchema,
  nowIso,
  newId,
  type ConformanceReport,
  type ExtensionManifest,
  type ExtensionRegistration,
  type RegistryStatus,
  type UserDecision,
} from "@keystone/schemas";
import { readJsonFile, withLock, writeFileAtomic } from "@keystone/kernel";
import { resolve } from "node:path";

import { canActivate, type IsolationTrigger } from "./activation.ts";

export interface RegistryLocation {
  readonly registryFile: string;
}

export class ActivationRefusedError extends Error {
  readonly extensionName: string;
  readonly blockers: readonly string[];
  constructor(extensionName: string, blockers: readonly string[]) {
    super(`cannot activate ${extensionName}: ${blockers.join("; ")}`);
    this.name = "ActivationRefusedError";
    this.extensionName = extensionName;
    this.blockers = blockers;
  }
}

export interface RegisterExtensionInput {
  readonly manifest: ExtensionManifest;
  readonly source: { kind: "bundled" | "local_path" | "npm" | "registry" | "git"; locator: string };
  readonly integrityVerified: boolean;
  readonly conformance?: ConformanceReport;
  readonly approvedBy?: readonly string[];
  readonly reviewHash?: string;
  readonly files?: readonly ReviewedFile[];
  readonly checkDependencies?: boolean;
}

export interface ReviewedFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface ExtensionHistoryEntry {
  readonly registration: ExtensionRegistration;
  readonly reviewHash?: string;
  readonly files: readonly ReviewedFile[];
}

/** Local projection metadata, not a new kernel event or registration schema. */
export interface ExtensionLifecycleMetadata {
  readonly reviewHash?: string;
  readonly files: readonly ReviewedFile[];
  readonly history: readonly ExtensionHistoryEntry[];
  readonly removedAt?: string;
}

interface RegistryDocument {
  readonly entries: readonly ExtensionRegistration[];
  readonly lifecycle?: Readonly<Record<string, ExtensionLifecycleMetadata>>;
}

export class ExtensionRegistry {
  private readonly location: RegistryLocation;
  private entries = new Map<string, ExtensionRegistration>();
  private lifecycle: Record<string, ExtensionLifecycleMetadata> = {};

  constructor(location: RegistryLocation) {
    this.location = { registryFile: resolve(location.registryFile) };
  }

  async load(): Promise<void> {
    await withLock(`${this.location.registryFile}.lock`, { staleMs: Infinity }, () => this.readDocument());
  }

  private async readDocument(): Promise<void> {
    const document = await readJsonFile<RegistryDocument>(
      this.location.registryFile,
    );
    const entries = new Map<string, ExtensionRegistration>();
    for (const raw of document?.entries ?? []) {
      const registration = extensionRegistrationSchema.parse(raw) as ExtensionRegistration;
      entries.set(registration.manifest.name, registration);
    }
    this.entries = entries;
    this.lifecycle = structuredClone(document?.lifecycle ?? {});
    for (const metadata of Object.values(this.lifecycle)) {
      if ((metadata.reviewHash !== undefined && !/^[a-f0-9]{64}$/.test(metadata.reviewHash)) ||
          !Array.isArray(metadata.files) || !Array.isArray(metadata.history)) {
        throw new Error("invalid registry lifecycle metadata; review again");
      }
      for (const entry of metadata.history) extensionRegistrationSchema.parse(entry.registration);
    }
  }

  list(): readonly ExtensionRegistration[] {
    return structuredClone([...this.entries.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    ));
  }

  get(name: string): ExtensionRegistration | undefined {
    const entry = this.entries.get(name);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  metadata(name: string): ExtensionLifecycleMetadata {
    return structuredClone(this.lifecycle[name] ?? { files: [], history: [] });
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.location.registryFile,
      `${JSON.stringify(
        { schemaVersion: "keystone.extension.registry@1.0.0", entries: this.list(), lifecycle: this.lifecycle },
        null,
        2,
      )}\n`,
    );
  }

  private async transaction<T>(action: () => Promise<T>): Promise<T> {
    // Never steal a live writer's lock based on elapsed time. A crashed writer
    // leaves an explicit lock recovery requirement instead of corrupting data.
    return withLock(`${this.location.registryFile}.lock`, { staleMs: Infinity }, async () => {
      await this.readDocument();
      const entries = new Map(this.entries);
      const lifecycle = structuredClone(this.lifecycle);
      try {
        const result = await action();
        await this.persist();
        return structuredClone(result);
      } catch (error) {
        this.entries = entries;
        this.lifecycle = lifecycle;
        throw error;
      }
    });
  }

  private async setStatus(
    name: string,
    status: RegistryStatus,
    patch: Partial<ExtensionRegistration> = {},
  ): Promise<ExtensionRegistration> {
    const existing = this.entries.get(name);
    if (existing === undefined) {
      throw new Error(`extension "${name}" is not registered`);
    }
    const updated = extensionRegistrationSchema.parse({
      ...existing,
      ...patch,
      status,
    }) as ExtensionRegistration;
    this.entries.set(name, updated);
    return updated;
  }

  /**
   * Install an extension. High-risk extensions need a live user decision at
   * activation time; registering them disabled preserves the audit trail without
   * granting anything.
   */
  async register(input: RegisterExtensionInput): Promise<ExtensionRegistration> {
    return this.transaction(async () => {
    if (input.checkDependencies === true) this.assertDependencies(input.manifest);
    const existing = this.entries.get(input.manifest.name);
    const previous = this.metadata(input.manifest.name);
    const changed = existing !== undefined &&
      (previous.reviewHash !== input.reviewHash || JSON.stringify(existing.manifest) !== JSON.stringify(input.manifest));
    const history = [...previous.history];
    if (changed && existing !== undefined) {
      if (history.length >= 128) throw new Error("extension history limit reached; no audit history was discarded");
      history.push({
        registration: existing, files: previous.files,
        ...(previous.reviewHash === undefined ? {} : { reviewHash: previous.reviewHash }),
      });
    }
    const registration = extensionRegistrationSchema.parse({
      extensionId: existing?.extensionId ?? newId("ext"),
      manifest: input.manifest,
      status: "registered",
      source: input.source,
      integrityVerified: input.integrityVerified,
      ...(input.conformance === undefined ? {} : { conformance: input.conformance }),
      installedAt: nowIso(),
      approvedBy: [...(input.approvedBy ?? [])],
    }) as ExtensionRegistration;

    this.entries.set(input.manifest.name, registration);
    this.lifecycle[input.manifest.name] = {
      ...(input.reviewHash === undefined ? {} : { reviewHash: input.reviewHash }),
      files: [...(input.files ?? [])], history,
    };
    return registration;
    });
  }

  async activate(
    name: string,
    options: { readonly decision?: UserDecision; readonly reviewHash?: string } = {},
  ): Promise<ExtensionRegistration> {
    return this.transaction(async () => {
    const existing = this.entries.get(name);
    if (existing === undefined) {
      throw new Error(`extension "${name}" is not registered`);
    }
    if (this.lifecycle[name]?.removedAt !== undefined) throw new Error(`extension "${name}" is uninstalled`);
    if (options.reviewHash !== undefined && this.lifecycle[name]?.reviewHash !== options.reviewHash) {
      throw new ActivationRefusedError(name, ["installed review hash changed"]);
    }
    this.assertDependencies(existing.manifest, true);
    if (existing.conformance !== undefined &&
        (existing.conformance.extensionName !== name ||
         existing.conformance.extensionVersion !== existing.manifest.version)) {
      throw new ActivationRefusedError(name, ["conformance belongs to another version"]);
    }

    const gate = canActivate({
      manifest: existing.manifest,
      ...(existing.conformance === undefined ? {} : { conformance: existing.conformance }),
      integrityVerified: existing.integrityVerified,
      ...(options.decision === undefined ? {} : { decision: options.decision }),
    });

    if (!gate.allowed) {
      throw new ActivationRefusedError(name, gate.blockers);
    }

    return this.setStatus(name, "active", {
      activatedAt: nowIso(),
      approvedBy: options.decision === undefined
        ? existing.approvedBy
        : [...new Set([...existing.approvedBy, options.decision.decisionId])].slice(-16),
    });
    });
  }

  assertDependencies(manifest: ExtensionManifest, activeOnly = false): void {
    const blockers: string[] = [];
    for (const dependency of manifest.dependencies) {
      const installed = this.entries.get(dependency.name);
      if (installed === undefined || this.lifecycle[dependency.name]?.removedAt !== undefined ||
          (activeOnly && installed.status !== "active") ||
          !versionSatisfies(installed.manifest.version, dependency.range)) {
        blockers.push(`dependency ${dependency.name}@${dependency.range} is missing, inactive or incompatible`);
      }
    }
    for (const other of this.entries.values()) {
      if (other.manifest.name === manifest.name || other.status !== "active") continue;
      if (manifest.conflicts.includes(other.manifest.name) || other.manifest.conflicts.includes(manifest.name)) {
        blockers.push(`conflict with active extension ${other.manifest.name}`);
      }
    }
    if (blockers.length > 0) throw new ActivationRefusedError(manifest.name, blockers);
  }

  /** Bind an observed probe to the registration still present after execution. */
  async recordProbe(name: string, reviewHash: string, report: ConformanceReport,
    integrityVerified: boolean, decisionId: string): Promise<ExtensionRegistration> {
    return this.transaction(async () => {
      const existing = this.entries.get(name);
      const metadata = this.metadata(name);
      if (existing === undefined || metadata.removedAt !== undefined ||
          metadata.reviewHash !== reviewHash || existing.status !== "registered") {
        throw new Error("extension changed or was disabled during probe; review again");
      }
      if (report.extensionName !== name || report.extensionVersion !== existing.manifest.version) {
        throw new Error("probe does not match installed version");
      }
      return this.setStatus(name, "registered", {
        conformance: report, integrityVerified,
        approvedBy: [...new Set([...existing.approvedBy, decisionId])].slice(-16),
      });
    });
  }

  /**
   * Cut an extension off after a crash, timeout, manifest violation or integrity
   * failure. The reason is stored so the task's checkpoint can explain why its
   * capabilities changed (PRD PL-02).
   */
  async isolate(
    name: string,
    trigger: IsolationTrigger,
    detail: string,
    reviewHash?: string,
  ): Promise<ExtensionRegistration> {
    return this.transaction(async () => {
      if (reviewHash !== undefined && this.lifecycle[name]?.reviewHash !== reviewHash) {
        throw new Error("installed review hash changed before isolation");
      }
      return this.setStatus(name, "isolated", {
      isolationReason: `[${trigger}] ${detail}`,
      });
    });
  }

  async disable(name: string): Promise<ExtensionRegistration> {
    return this.transaction(() => this.setStatus(name, "disabled"));
  }

  async reject(name: string, reason: string): Promise<ExtensionRegistration> {
    return this.transaction(() => this.setStatus(name, "rejected", { isolationReason: reason }));
  }

  async uninstall(name: string): Promise<ExtensionRegistration> {
    return this.transaction(async () => {
      const entry = await this.setStatus(name, "disabled");
      this.lifecycle[name] = { ...this.metadata(name), removedAt: nowIso() };
      return entry;
    });
  }
  /** Extensions that are active and therefore able to influence a running task. */
  active(): readonly ExtensionRegistration[] {
    return this.list().filter((registration) => registration.status === "active");
  }

  /**
   * Registrations that cannot be explained: an isolated or rejected extension
   * with no recorded reason. The caller must move affected tasks to "needs
   * attention" rather than proceed (PRD 9.7).
   */
  unexplained(): readonly ExtensionRegistration[] {
    return this.list().filter(
      (registration) =>
        (registration.status === "isolated" || registration.status === "rejected") &&
        (registration.isolationReason === undefined || registration.isolationReason === ""),
    );
  }
}

/** Resolve the deliberately small range grammar accepted by the local kit. */
export function versionSatisfies(version: string, range: string): boolean {
  if (range === "*" || range === "latest") return true;
  const actual = version.split("-")[0]!.split(".").map(Number);
  return range.split("||").some((part) => {
    const match = /^(\^|~|>=|<=|>|<|=)?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?(?:-([0-9A-Za-z.-]+))?$/.exec(part.trim());
    if (match === null) return false;
    const expected = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    if (match[3] === "x") return actual[0] === expected[0] && !version.includes("-");
    if (match[4] === "x") return actual[0] === expected[0] && actual[1] === expected[1] && !version.includes("-");
    if (version.includes("-") || match[5] !== undefined) return part.trim().replace(/^=/, "") === version;
    const compare = actual.reduce((result, value, index) => result || Math.sign(value - expected[index]!), 0);
    switch (match[1]) {
      case ">=": return compare >= 0;
      case ">": return compare > 0;
      case "<=": return compare <= 0;
      case "<": return compare < 0;
      case "^": return compare >= 0 && (expected[0] !== 0 ? actual[0] === expected[0]
        : expected[1] !== 0 ? actual[0] === 0 && actual[1] === expected[1]
        : actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2]);
      case "~": return compare >= 0 && actual[0] === expected[0] && (match[3] === undefined || actual[1] === expected[1]);
      default: return compare === 0;
    }
  });
}
