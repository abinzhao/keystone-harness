/**
 * Extension manifests: validation, integrity, and the install review.
 *
 * A manifest is a *declaration of what an extension wants*, shown to the user
 * before anything runs. Two rules follow from that framing:
 *
 *  - Nothing in a manifest grants anything. The kernel still issues leases, and
 *    an extension can only ever receive a capability that the user's envelope
 *    already allows (PRD PL-02, 9.7).
 *  - A manifest that under-declares is a manifest that fails. If an extension
 *    says it will write files, it must also declare the `fs_write` side effect;
 *    if it can reach the network, it must say where and which data classes go
 *    there (PRD PL-01, 11.4).
 */

import {
  extensionManifestSchema,
  sha256Bytes,
  type Capability,
  type ExtensionManifest,
} from "@keystone/schemas";

export class ManifestError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`extension manifest is invalid: ${issues.join("; ")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

export interface ParsedManifest {
  readonly manifest: ExtensionManifest;
  /** sha256 of the bytes the manifest was read from. */
  readonly digest: string;
  /** True when the manifest's declared digest matches the actual bytes. */
  readonly integrityVerified: boolean;
}

export function parseManifest(value: unknown, providedBytes?: Uint8Array): ParsedManifest {
  const manifest = extensionManifestSchema.parse(value) as ExtensionManifest;
  const digest = providedBytes === undefined ? "" : sha256Bytes(providedBytes);
  return {
    manifest,
    digest,
    integrityVerified:
      providedBytes === undefined ? false : digest === manifest.integrity.digest,
  };
}

export function verifyIntegrity(manifest: ExtensionManifest, bytes: Uint8Array): boolean {
  return sha256Bytes(bytes) === manifest.integrity.digest;
}

/**
 * Capabilities that carry a visible side effect, and the side effect the
 * manifest must declare for each. Missing pairs are treated as under-declaration
 * rather than as a convenience.
 */
const REQUIRED_SIDE_EFFECTS: readonly { capability: Capability; effects: readonly string[] }[] = [
  { capability: "fs.read", effects: ["fs_read"] },
  { capability: "fs.write", effects: ["fs_write"] },
  { capability: "fs.delete", effects: ["fs_write"] },
  { capability: "cmd.exec", effects: ["process_spawn"] },
  { capability: "net.fetch", effects: ["network"] },
  { capability: "credential.use", effects: ["network"] },
  { capability: "external.write", effects: ["external_write", "network"] },
];

/** Kinds that must ask for at least one capability to be able to do anything. */
const KINDS_REQUIRING_CAPABILITY = new Set(["tool", "verifier", "analyzer", "workspace"]);

export interface DeclarationCheck {
  readonly checkId: string;
  readonly passed: boolean;
  readonly blocking: boolean;
  readonly detail: string;
}

/**
 * Internal consistency of a manifest. Deliberately separates blocking problems
 * (the extension cannot be trusted to behave) from advisory ones (the user
 * should know, but it is not a defect).
 */
export function checkDeclarations(manifest: ExtensionManifest): readonly DeclarationCheck[] {
  const checks: DeclarationCheck[] = [];

  if (KINDS_REQUIRING_CAPABILITY.has(manifest.kind) && manifest.capabilities.length === 0) {
    checks.push({
      checkId: "declaration.capabilities_present",
      passed: false,
      blocking: true,
      detail: `a ${manifest.kind} extension declares no capabilities, so it could not act at all`,
    });
  } else {
    checks.push({
      checkId: "declaration.capabilities_present",
      passed: true,
      blocking: true,
      detail: `${manifest.capabilities.length} capability request(s) declared`,
    });
  }

  const declaredEffects = new Set(manifest.sideEffects.map((effect) => effect.kind));
  for (const requirement of REQUIRED_SIDE_EFFECTS) {
    if (!manifest.capabilities.includes(requirement.capability)) continue;
    const satisfied = requirement.effects.some((effect) => declaredEffects.has(effect as never));
    checks.push({
      checkId: `declaration.side_effect.${requirement.capability}`,
      passed: satisfied,
      blocking: true,
      detail: satisfied
        ? `${requirement.capability} is matched by a declared side effect`
        : `${requirement.capability} is requested but none of ${requirement.effects.join("/")} is declared`,
    });
  }

  if (manifest.capabilities.includes("net.fetch") || manifest.capabilities.includes("external.write")) {
    checks.push({
      checkId: "declaration.egress_declared",
      passed: manifest.egressHosts.length > 0,
      blocking: true,
      detail:
        manifest.egressHosts.length > 0
          ? `network egress limited to ${manifest.egressHosts.join(", ")}`
          : "network egress is requested but no destination host is declared",
    });
    checks.push({
      checkId: "declaration.egress_data_classes",
      passed: manifest.dataClassification.egress.length > 0,
      blocking: true,
      detail:
        manifest.dataClassification.egress.length > 0
          ? "data classes that may leave the machine are declared"
          : "network egress is requested but no data class is declared as leaving the machine",
    });
  }

  if (manifest.dataClassification.reads === "secret") {
    checks.push({
      checkId: "declaration.reads_secret",
      passed: true,
      blocking: false,
      detail:
        "the extension declares it may read secret-class data; the kernel still never puts credentials in a model context",
    });
  }

  if (manifest.kind === "verifier" && manifest.produces.evidenceTypes.length === 0) {
    checks.push({
      checkId: "declaration.verifier_evidence_types",
      passed: false,
      blocking: true,
      detail: "a verifier must declare which evidence types it can produce",
    });
  }

  checks.push({
    checkId: "declaration.no_self_elevation",
    passed: !manifest.capabilities.includes("extension.activate"),
    blocking: true,
    detail: manifest.capabilities.includes("extension.activate")
      ? "an extension cannot be granted the ability to activate other extensions"
      : "the extension cannot activate other extensions",
  });

  // A `protocol` extension in this build is only reachable over a declared
  // local stdio transport (ADR-0009). A transport block, in turn, belongs only
  // on a protocol extension: an in-process verifier that declares one is lying
  // about how it runs.
  if (manifest.kind === "protocol") {
    checks.push({
      checkId: "declaration.protocol_transport",
      passed: manifest.transport?.type === "stdio",
      blocking: true,
      detail:
        manifest.transport?.type === "stdio"
          ? `launched as stdio command "${manifest.transport.command}"`
          : "a protocol extension must declare a local stdio transport (no remote transport exists in this build)",
    });
  } else if (manifest.transport !== undefined) {
    checks.push({
      checkId: "declaration.protocol_transport",
      passed: false,
      blocking: true,
      detail: `a stdio transport may only be declared by kind "protocol", not "${manifest.kind}"`,
    });
  }

  checks.push({
    checkId: "declaration.uninstall",
    passed: manifest.uninstall !== "requires_cleanup" || manifest.description !== undefined,
    blocking: false,
    detail:
      manifest.uninstall === "requires_cleanup"
        ? "uninstall requires cleanup; the manifest should explain what is left behind"
        : `uninstall behaviour: ${manifest.uninstall}`,
  });

  checks.push({
    checkId: "declaration.conflicts",
    passed: manifest.conflicts.length === 0,
    blocking: false,
    detail:
      manifest.conflicts.length === 0
        ? "no known conflicts declared"
        : `declares conflicts with ${manifest.conflicts.join(", ")}`,
  });

  return checks;
}

export interface InstallReview {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly kind: string;
  readonly canDo: readonly string[];
  readonly dataEgress: readonly string[];
  readonly reversibility: string;
  readonly uninstall: string;
  readonly advisory: readonly string[];
}

/** What the user is being asked to accept, in plain language. */
export function describeInstallReview(manifest: ExtensionManifest): InstallReview {
  const canDo = manifest.capabilities.map((capability) => capability);
  const dataEgress =
    manifest.dataClassification.egress.length === 0
      ? ["nothing leaves the machine"]
      : manifest.dataClassification.egress.map(
          (rule) =>
            `${rule.dataClass} data may be sent to ${rule.destination} (${rule.purpose})`,
        );

  return {
    name: manifest.name,
    version: manifest.version,
    publisher: manifest.publisher,
    kind: manifest.kind,
    canDo,
    dataEgress,
    reversibility: manifest.reversibility,
    uninstall: manifest.uninstall,
    advisory: checkDeclarations(manifest)
      .filter((check) => !check.blocking && !check.passed)
      .map((check) => check.detail),
  };
}
