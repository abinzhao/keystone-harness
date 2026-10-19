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
import { readJsonFile, writeFileAtomic } from "@keystone/kernel";

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
}

export class ExtensionRegistry {
  private readonly location: RegistryLocation;
  private entries = new Map<string, ExtensionRegistration>();

  constructor(location: RegistryLocation) {
    this.location = location;
  }

  async load(): Promise<void> {
    const document = await readJsonFile<{ entries?: ExtensionRegistration[] }>(
      this.location.registryFile,
    );
    this.entries = new Map();
    for (const raw of document?.entries ?? []) {
      const registration = extensionRegistrationSchema.parse(raw) as ExtensionRegistration;
      this.entries.set(registration.manifest.name, registration);
    }
  }

  list(): readonly ExtensionRegistration[] {
    return [...this.entries.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
  }

  get(name: string): ExtensionRegistration | undefined {
    return this.entries.get(name);
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.location.registryFile,
      `${JSON.stringify(
        { schemaVersion: "keystone.extension.registry@1.0.0", entries: this.list() },
        null,
        2,
      )}\n`,
    );
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
    await this.persist();
    return updated;
  }

  /**
   * Install an extension. High-risk extensions need a live user decision at
   * activation time; registering them disabled preserves the audit trail without
   * granting anything.
   */
  async register(input: RegisterExtensionInput): Promise<ExtensionRegistration> {
    const existing = this.entries.get(input.manifest.name);
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
    await this.persist();
    return registration;
  }

  async activate(
    name: string,
    options: { readonly decision?: UserDecision } = {},
  ): Promise<ExtensionRegistration> {
    const existing = this.entries.get(name);
    if (existing === undefined) {
      throw new Error(`extension "${name}" is not registered`);
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
        : [...existing.approvedBy, options.decision.decisionId],
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
  ): Promise<ExtensionRegistration> {
    return this.setStatus(name, "isolated", {
      isolationReason: `[${trigger}] ${detail}`,
    });
  }

  async disable(name: string): Promise<ExtensionRegistration> {
    return this.setStatus(name, "disabled");
  }

  async reject(name: string, reason: string): Promise<ExtensionRegistration> {
    return this.setStatus(name, "rejected", { isolationReason: reason });
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
