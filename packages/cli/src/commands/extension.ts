/**
 * `keystone extension` — end-user governed extension management.
 *
 * This is the user trigger the registry and Conformance Kit were missing. It
 * wires the existing semantics together without changing any of them:
 *
 *  - `install <path>` reads a *local* package, verifies its digest against the
 *    bytes that would run, discloses static checks and risks, obtains explicit
 *    consent, then probes a temporary copy before recording the extension.
 *  - `activate` enforces the activation gate: conformance, integrity and — for
 *    egress — a live user decision. It can never widen a capability.
 *  - `inspect` shows the same review without changing any state.
 *  - `list` / `isolate` read and cut off the persistent registry.
 *
 * There is no remote marketplace: installation is local-path first, so the user
 * can point at exactly the directory they trust (PRD PL-01, PL-02, 9.7).
 */

import {
  ExtensionRegistry,
  canActivate,
  checkSkillConformance,
  defaultRegistryLocation,
  discoverSkills,
  prepareLocalInstall,
  probeLocalInstall,
  summarizeConformance,
  type InstallReview,
} from "@keystone/extensions";
import { newId, nowIso, userDecisionSchema, type UserDecision } from "@keystone/schemas";
import { resolve } from "node:path";

import { getBoolean, getString, parseArgs, UsageError } from "../args.ts";
import { createOutput } from "../output.ts";
import {
  pathsFor,
  translatorForContext,
  type CliContext,
  type CommandModule,
} from "./shared.ts";

function openRegistry(context: CliContext): ExtensionRegistry {
  return new ExtensionRegistry(defaultRegistryLocation(pathsFor(context).home));
}

function requiredPositional(args: { readonly positionals: readonly string[] }, which: string): string {
  const value = args.positionals[0];
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`expected a ${which} argument`);
  }
  return value;
}

/** A user-issued decision, valid in shape and `recordedBy: "user"`. */
function userConfirmationDecision(rationale: string, resources: readonly string[] = []): UserDecision {
  return userDecisionSchema.parse({
    decisionId: newId("dec"),
    taskId: newId("task"),
    branchId: newId("branch"),
    at: nowIso(),
    decision: "allow",
    rationale,
    appliesTo: { resources: [...resources] },
    recordedBy: "user",
  }) as UserDecision;
}

/**
 * Ask for an explicit yes. With `--yes` the answer is taken as given; otherwise
 * a real terminal is prompted on stdin. Any non-interactive caller must pass
 * `--yes` — a pipe that cannot be answered must not silently be treated as
 * consent (PRD PL-02).
 */
async function askForConfirmation(
  context: CliContext,
  question: string,
  assumeYes: boolean,
): Promise<boolean> {
  if (assumeYes) return true;
  if (!context.isTTY) return false;
  context.stderr.write(`${question} [y/N] `);
  const source = context.stdin ?? process.stdin;
  let answer = "";
  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    answer += text;
    if (answer.includes("\n")) break;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function printReview(output: ReturnType<typeof createOutput>, review: InstallReview): void {
  output.keyValue({
    Name: review.name,
    Version: review.version,
    Publisher: review.publisher,
    Kind: review.kind,
  });
  output.line(`  ${review.canDo.join(", ")}`);
  output.line(`  egress: ${review.dataEgress.join("; ")}`);
  output.line(`  reversibility: ${review.reversibility}; uninstall: ${review.uninstall}`);
  for (const note of review.advisory) output.detail(`advisory: ${note}`);
}

async function runInspect(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["path"],
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const packageRoot = requiredPositional(args, "package path");

  const prepared = await prepareLocalInstall(packageRoot);
  output.section(t("Extension review"));
  printReview(output, prepared.read.review);
  output.keyValue({
    "Integrity": prepared.read.integrityBasis === "local_path_trust"
      ? t("local-path trust only; no content digest verified")
      : prepared.read.integrityVerified ? t("digest matches the entry on disk")
      : t("digest does NOT match the entry on disk"),
    "Static checks": prepared.staticChecksPassed ? t("passed") : t("failed"),
    "Probes": t("pending consent; no third-party code executed"),
  });
  if (!prepared.staticChecksPassed) {
    output.line(summarizeConformance(prepared.conformance));
  }
  output.line(t("Static review is not installation or runtime activation."));
  output.json({
    name: prepared.read.manifest.name,
    phase: prepared.phase,
    reviewHash: prepared.reviewHash,
    files: prepared.files,
    staticChecksPassed: prepared.staticChecksPassed,
    probes: "pending_consent",
    review: prepared.read.review,
    integrityBasis: prepared.read.integrityBasis,
    integrityVerified: prepared.read.integrityVerified,
    conformance: { passed: prepared.conformance.passed, reportHash: prepared.conformance.reportHash },
    gate: prepared.gate,
  });
  return 0;
}

async function runInstall(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["path"],
    flags: { "yes": "boolean", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const packageRoot = requiredPositional(args, "package path");

  const prepared = await prepareLocalInstall(packageRoot);
  const { read } = prepared;

  // Integrity is the first gate: a digest that does not match never reaches the
  // registry at all, so nothing untrusted can be recorded as installed.
  if (read.integrityBasis === "entry_digest" && !read.integrityVerified) {
    output.error(
      t(
        "refusing to install: the manifest digest does not match the entry on disk; the package may have been altered",
      ),
    );
    return 1;
  }
  if (!prepared.staticChecksPassed) {
    output.error(summarizeConformance(prepared.conformance));
    output.error(t("refusing to install: the extension failed static checks"));
    return 1;
  }
  if (read.manifest.reversibility === "irreversible") {
    output.error(t("refusing to install: an irreversible extension cannot be activated automatically"));
    return 1;
  }

  output.section(t("About to install"));
  printReview(output, read.review);

  const disclosure = t(
    "Approval runs third-party code in a copied temporary workspace (5s, 64KiB output limit). " +
    "Node probes restrict filesystem/process access; this is not a network or OS sandbox. " +
    "Other executables have only process/time/output isolation. No credentials are inherited. " +
    "Registration does not activate it in a running runtime.",
  );
  output.line(disclosure);
  if (getBoolean(args, "json")) {
    context.stderr.write(`${JSON.stringify({
      phase: "static", reviewHash: prepared.reviewHash, files: prepared.files,
      review: read.review, integrityBasis: read.integrityBasis, disclosure,
    })}\n`);
  }
  const confirmed = await askForConfirmation(
    context, t("Approve the bounded probes and local installation?"), getBoolean(args, "yes"),
  );
  if (!confirmed) {
    output.error(t("not installed: you did not approve the bounded probes"));
    return 1;
  }

  const decision = userConfirmationDecision(
    "confirmed bounded probes and local installation at keystone extension install",
    [prepared.reviewHash],
  );
  const probed = await probeLocalInstall(packageRoot, { decision, reviewHash: prepared.reviewHash });
  if (!probed.conformance.passed || !probed.gate.allowed) {
    output.error(summarizeConformance(probed.conformance));
    output.error(t("refusing to install: {blockers}", { blockers: probed.gate.blockers.join("; ") }));
    return 1;
  }
  const registry = openRegistry(context);
  await registry.load();
  const registered = await registry.register({
    manifest: read.manifest,
    source: { kind: "local_path", locator: resolve(packageRoot) },
    integrityVerified: probed.read.integrityVerified,
    conformance: probed.conformance,
    approvedBy: [decision.decisionId],
  });

  output.line(
    t('installed "{name}" ({status}). Run `keystone extension activate {name}` to enable it.', {
      name: registered.manifest.name,
      status: registered.status,
    }),
  );
  output.line(t("Registry registration only; runtime activation: not observed."));
  output.json({
    name: registered.manifest.name, status: registered.status,
    registryStatus: registered.status, runtimeActivation: "not_observed",
  });
  return 0;
}

async function runList(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, { flags: { json: "boolean", verbose: "boolean" } });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });

  const registry = openRegistry(context);
  await registry.load();
  const entries = registry.list();
  output.section(t("Extensions"));
  if (entries.length === 0) output.line(`  ${t("none installed")}`);
  for (const entry of entries) {
    output.line(
      `  [${entry.status}] ${entry.manifest.name}@${entry.manifest.version} ` +
        `(${entry.source.kind}, ${entry.integrityVerified ? t("integrity ok") : t("integrity UNVERIFIED")})`,
    );
    output.detail(
      `publisher: ${entry.manifest.publisher}; capabilities: ${entry.manifest.capabilities.join(", ")}`,
    );
    if (entry.isolationReason !== undefined) {
      output.detail(`isolation: ${entry.isolationReason}`);
    }
  }
  output.line(t("Registry status only; runtime activation: not observed."));
  output.json(entries.map((entry) => ({
    ...entry, registryStatus: entry.status, runtimeActivation: "not_observed",
  })));
  return 0;
}

async function runActivate(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["name"],
    flags: { "yes": "boolean", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const name = requiredPositional(args, "extension name");

  const registry = openRegistry(context);
  await registry.load();
  const existing = registry.get(name);
  if (existing === undefined) {
    throw new UsageError(`extension "${name}" is not installed; run \`keystone extension install <path>\``);
  }

  const withoutDecision = canActivate({
    manifest: existing.manifest,
    integrityVerified: existing.integrityVerified,
    ...(existing.conformance === undefined ? {} : { conformance: existing.conformance }),
  });

  if (withoutDecision.allowed) {
    const activated = await registry.activate(name);
    output.line(t('registry status for "{name}": {status}; runtime activation: not observed.', {
      name, status: activated.status,
    }));
    output.json({ name, status: activated.status, registryStatus: activated.status, runtimeActivation: "not_observed" });
    return 0;
  }

  // If the *only* thing missing is a live user decision for egress, an explicit
  // yes supplies it. Anything else (integrity, conformance, irreversibility)
  // cannot be talked past, even with confirmation.
  const withDecision = canActivate({
    manifest: existing.manifest,
    integrityVerified: existing.integrityVerified,
    ...(existing.conformance === undefined ? {} : { conformance: existing.conformance }),
    decision: userConfirmationDecision("confirmed at keystone extension activate"),
  });

  if (withDecision.allowed && withoutDecision.requiresConfirmation) {
    const confirmed = await askForConfirmation(
      context,
      t("This extension can reach outside the machine. Activate it?"),
      getBoolean(args, "yes"),
    );
    if (!confirmed) {
      output.error(t("not activated: you did not confirm the egress risk"));
      return 1;
    }
    const activated = await registry.activate(name, {
      decision: userConfirmationDecision("confirmed at keystone extension activate"),
    });
    output.line(t('registry status for "{name}": {status}; runtime activation: not observed.', {
      name, status: activated.status,
    }));
    output.json({ name, status: activated.status, registryStatus: activated.status, runtimeActivation: "not_observed" });
    return 0;
  }

  output.error(t("cannot activate {name}: {blockers}", { name, blockers: withoutDecision.blockers.join("; ") }));
  return 1;
}

async function runIsolate(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["name"],
    flags: { reason: "string", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const name = requiredPositional(args, "extension name");

  const registry = openRegistry(context);
  await registry.load();
  const existing = registry.get(name);
  if (existing === undefined) {
    throw new UsageError(`extension "${name}" is not installed`);
  }
  const reason = getString(args, "reason") ?? "manually isolated by the user";
  const isolated = await registry.isolate(name, "user_disabled", reason);
  output.line(t('isolated "{name}": {reason}', { name, reason: isolated.isolationReason ?? reason }));
  output.json({ name, status: isolated.status });
  return 0;
}

/**
 * `keystone extension skills <dir>...` — inspect on-disk Agent Skills.
 *
 * Read-only and progressive: discovery parses only SKILL.md frontmatter, grants
 * nothing, runs no script, and discloses the declared resources/scripts. A
 * changed digest is surfaced so upgrades are visible but never auto-trusted
 * (ADR-0009).
 */
async function runSkills(argv: readonly string[], context: CliContext): Promise<number> {
  const t = translatorForContext(context);
  const args = parseArgs(argv, {
    positionals: ["dir"],
    variadic: true,
    flags: { json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const roots = args.positionals;
  if (roots.length === 0) {
    throw new UsageError(t("expected at least one skills directory to inspect"));
  }

  const skills = await discoverSkills(roots.map((root) => resolve(root)));
  output.section(t("Discovered Agent Skills"));
  if (skills.length === 0) {
    output.line(`  ${t("no skills found")}`);
  }
  for (const skill of skills) {
    output.line(`  ${skill.name} — ${skill.description}`);
    output.detail(`    dir: ${skill.dir}; digest: ${skill.digest.slice(0, 12)}`);
    if (skill.resources.length > 0) output.detail(`    resources: ${skill.resources.join(", ")}`);
    if (skill.scripts.length > 0) {
      output.detail(`    scripts (disclosed, never run on discovery): ${skill.scripts.join(", ")}`);
    }
    const failed = checkSkillConformance(skill).filter((c) => !c.passed);
    for (const check of failed) output.detail(`    advisory: ${check.detail}`);
  }
  output.line(
    t("skills are untrusted input; discovering them grants no capability and runs no script"),
  );
  output.json(skills);
  return 0;
}

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "inspect":
      return runInspect(rest, context);
    case "install":
      return runInstall(rest, context);
    case "list":
      return runList(rest, context);
    case "activate":
      return runActivate(rest, context);
    case "isolate":
      return runIsolate(rest, context);
    case "skills":
      return runSkills(rest, context);
    default:
      throw new UsageError(
        `unknown subcommand "extension ${sub ?? ""}"; expected one of inspect, install, list, activate, isolate, skills`,
      );
  }
}

export const command: CommandModule = {
  name: "extension",
  summary: (t) => t("Install, review, activate and isolate local extensions"),
  usage: "keystone extension <inspect|install|list|activate|isolate> ...",
  help: [
    "keystone extension inspect <path>",
    "  Show the manifest review, integrity and conformance result without changing state.",
    "",
    "keystone extension install <path> [--yes]",
    "  Install a local extension: verify digest, run conformance, disclose risks. A",
    "  local, reversible extension admits automatically; one that reaches outside the",
    "  machine needs --yes (or an interactive y/N). Irreversible extensions are refused.",
    "",
    "keystone extension list",
    "  List installed extensions and their status.",
    "",
    "keystone extension activate <name> [--yes]",
    "  Activate an installed extension. Egress extensions require an explicit --yes.",
    "",
    "keystone extension isolate <name> [--reason <text>]",
    "  Cut an extension off, recording why.",
    "",
    "keystone extension skills <dir>...",
    "  Inspect on-disk Agent Skills (SKILL.md + resources/scripts). Read-only: lists",
    "  frontmatter, discloses resources/scripts, grants no capability and runs no script.",
  ].join("\n"),
  run,
};
