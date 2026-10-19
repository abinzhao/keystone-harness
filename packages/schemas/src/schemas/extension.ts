/**
 * Extension Manifest.
 *
 * Everything that is not the kernel is a governed extension: models, tools,
 * analyzers, verifiers, workspaces, protocol adapters, skills. The manifest is
 * how an extension declares — before it runs — what it needs, what it may
 * touch, what data may leave the machine, and how it behaves on uninstall
 * (PRD PL-01).
 *
 * A manifest is a *declaration*, not a grant. It can only reduce what the user's
 * envelope allows; the kernel still issues leases (PRD PL-02, 9.7).
 */

import { extensionIdValidator, isoTimestampValidator, sha256Validator } from "./ids.ts";
import { CAPABILITIES } from "./capability.ts";
import {
  arrayOf,
  bool,
  defineSchema,
  enumOf,
  lit,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  type InferSchema,
} from "../validate.ts";

export const EXTENSION_KINDS = [
  "model",
  "tool",
  "analyzer",
  "verifier",
  "workspace",
  "protocol",
  "skill",
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const DATA_CLASSES = ["public", "internal", "sensitive", "secret"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const SIDE_EFFECTS = [
  "none",
  "fs_read",
  "fs_write",
  "process_spawn",
  "network",
  "external_write",
] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

export const REVERSIBILITY = ["reversible", "compensable", "irreversible"] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];

export const UNINSTALL_BEHAVIORS = ["safe", "requires_cleanup", "unsupported"] as const;

const sideEffectSchema = defineSchema(
  "keystone.extension.sideEffect",
  "1.0.0",
  objectOf({
    kind: enumOf(SIDE_EFFECTS),
    /** Human-readable bound, e.g. "writes only under .keystone/tmp". */
    scope: optional(str({ maxLength: 512 })),
  }),
);

/**
 * A destination that data of a given class may reach. Declared per class so
 * that "this plugin sends your code to its own server" is visible at install
 * time rather than discovered later (PRD 11.4, 11.7).
 */
const egressRuleSchema = defineSchema(
  "keystone.extension.egressRule",
  "1.0.0",
  objectOf({
    dataClass: enumOf(DATA_CLASSES),
    destination: nonEmptyStr(),
    purpose: nonEmptyStr(),
  }),
);

export const extensionManifestSchema = defineSchema(
  "keystone.extension.manifest",
  "1.0.0",
  objectOf({
    /** Human-readable package name, e.g. `keystone-verifier-vitest`. */
    name: str({ pattern: /^[a-z0-9][a-z0-9-_.]{1,63}$/ }),
    version: str({ pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
    publisher: nonEmptyStr(),
    integrity: objectOf({
      algorithm: lit("sha256"),
      digest: sha256Validator,
    }),
    kind: enumOf(EXTENSION_KINDS),
    /** Keystone Runtime protocol the extension was built against. */
    apiVersion: str({ pattern: /^\d+\.\d+$/ }),

    /** Capabilities the extension may ask for. Grants are still per-lease. */
    capabilities: arrayOf(enumOf(CAPABILITIES), { maxItems: 32 }),
    sideEffects: arrayOf(sideEffectSchema.validator, { maxItems: 32 }),
    reversibility: enumOf(REVERSIBILITY),

    /** Hosts the extension may contact. Exact names, no wildcards. */
    egressHosts: arrayOf(nonEmptyStr(), { maxItems: 64 }),
    /** Credential handles it may request. Never the secrets themselves. */
    credentialHandles: arrayOf(nonEmptyStr(), { maxItems: 32 }),

    dataClassification: objectOf({
      /** Most sensitive class the extension may read. */
      reads: enumOf(DATA_CLASSES),
      /** Classes it may transmit, and where. */
      egress: arrayOf(egressRuleSchema.validator, { maxItems: 32 }),
    }),

    /** Observable outputs, used for conformance and for chaining. */
    produces: objectOf({
      observations: arrayOf(nonEmptyStr(), { maxItems: 32 }),
      evidenceTypes: arrayOf(nonEmptyStr(), { maxItems: 32 }),
    }),

    execution: objectOf({
      /** True when the same inputs reproduce the same outputs. */
      replayable: bool(),
      idempotent: bool(),
    }),

    dependencies: arrayOf(
      objectOf({
        name: nonEmptyStr(),
        /** Semver range. Resolved before activation. */
        range: nonEmptyStr(),
      }),
      { maxItems: 64 },
    ),
    /** Known-incompatible extensions or versions. */
    conflicts: arrayOf(nonEmptyStr(), { maxItems: 32 }),

    uninstall: enumOf(UNINSTALL_BEHAVIORS),
    /** Entry point, interpreted by the extension host for this `kind`. */
    entry: objectOf({
      module: nonEmptyStr(),
      export: nonEmptyStr(),
    }),
    /** Free-form notes shown during installation review. */
    description: optional(str({ maxLength: 2000 })),
  }),
);

export type ExtensionManifest = InferSchema<typeof extensionManifestSchema>;

export const REGISTRY_STATUSES = [
  "registered",
  "active",
  "isolated",
  "disabled",
  "rejected",
] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

/** Conformance result. An extension cannot be activated without a passing run. */
export const conformanceReportSchema = defineSchema(
  "keystone.extension.conformanceReport",
  "1.0.0",
  objectOf({
    extensionName: nonEmptyStr(),
    extensionVersion: nonEmptyStr(),
    apiVersion: nonEmptyStr(),
    passed: bool(),
    checks: arrayOf(
      objectOf({
        checkId: nonEmptyStr(),
        passed: bool(),
        detail: str({ maxLength: 2000 }),
        /** True when a failure is fatal rather than advisory. */
        blocking: bool(),
      }),
      { maxItems: 256 },
    ),
    reportHash: sha256Validator,
    at: isoTimestampValidator,
  }),
);

export type ConformanceReport = InferSchema<typeof conformanceReportSchema>;

export const extensionRegistrationSchema = defineSchema(
  "keystone.extension.registration",
  "1.0.0",
  objectOf({
    extensionId: extensionIdValidator,
    manifest: extensionManifestSchema.validator,
    status: enumOf(REGISTRY_STATUSES),
    /** Where the package came from — shown at install time and kept for audit. */
    source: objectOf({
      kind: enumOf(["bundled", "local_path", "npm", "registry", "git"] as const),
      locator: nonEmptyStr(),
    }),
    integrityVerified: bool(),
    conformance: optional(conformanceReportSchema.validator),
    installedAt: isoTimestampValidator,
    activatedAt: optional(isoTimestampValidator),
    /** Set when the extension was isolated after activation. */
    isolationReason: optional(str({ maxLength: 2000 })),
    /** Decisions that approved installation. */
    approvedBy: arrayOf(nonEmptyStr(), { maxItems: 16 }),
  }),
);

export type ExtensionRegistration = InferSchema<typeof extensionRegistrationSchema>;
