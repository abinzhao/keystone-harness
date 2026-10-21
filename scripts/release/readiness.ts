import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  arrayOf, defineSchema, enumOf, jsonValue, lit, nonEmptyStr, objectOf, optional, sha256Bytes, str,
  type InferSchema,
} from "../../packages/schemas/src/index.ts";

export const LOCAL_GATES = ["typecheck", "tests", "conformance", "offline_smoke", "release_check", "evaluation"] as const;
export const STABLE_GATES = [...LOCAL_GATES, "source_clean", "macos_universal", "embedded_node",
  "macos_signing", "notarization", "live_provider", "windows", "hosted_ci", "release_approval"] as const;
const digest = str({ pattern: /^[0-9a-f]{64}$/ });
const binding = {
  releaseVersion: str({ pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
  sourceCommit: str({ pattern: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ }),
  sourceDigest: digest, artifactDigest: digest,
};
const inputSchema = defineSchema("keystone.release.readinessInput", "1.0.0", objectOf({
  version: lit("keystone.release-readiness/1"), ...binding,
  gates: arrayOf(objectOf({
    gateId: enumOf(STABLE_GATES), status: enumOf(["passed", "failed", "blocked", "missing"] as const),
    evidence: optional(objectOf({ path: nonEmptyStr(), sha256: digest })),
  }), { maxItems: STABLE_GATES.length }),
}));
const evidenceSchema = defineSchema("keystone.release.gateEvidence", "1.0.0", objectOf({
  version: lit("keystone.release-evidence/1"), ...binding, gateId: enumOf(STABLE_GATES),
  status: enumOf(["passed", "failed", "blocked"] as const), observedAt: nonEmptyStr(), details: jsonValue(),
}));
export type ReleaseReadinessInput = InferSchema<typeof inputSchema>;
export type ReleaseGateEvidence = InferSchema<typeof evidenceSchema>;
export type ReleaseGateId = typeof STABLE_GATES[number];
export interface ReadinessOptions { readonly root: string; readonly now?: Date; readonly maxAgeMs?: number }
export interface ReadinessScorecard {
  version: "keystone.release-readiness-result/1";
  releaseVersion: string; sourceCommit: string; sourceDigest: string; artifactDigest: string;
  generatedAt: string; channel: "rc" | "stable"; localReady: boolean; stableReady: boolean;
  gates: { gateId: ReleaseGateId; status: "passed" | "failed" | "blocked" | "missing" | "invalid";
    requiredFor: "local" | "stable"; evidenceDigest: string | null; reason: string }[];
  limits: readonly string[];
}
async function boundedFile(root: string, relative: string): Promise<Buffer> {
  if (!/^(?:artifacts\/[0-9a-f]{64}\.json|readiness-input\.json)$/.test(relative)) throw new Error("nonportable evidence path");
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("evidence symlink");
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("evidence size or kind");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error("evidence changed during read");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
function detailsOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("gate details required");
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function commandPassed(details: Record<string, unknown>): boolean {
  return Array.isArray(details.command) && details.command.length > 0 && details.command.every(text) &&
    details.exitCode === 0 && positive(details.checks) && details.failures === 0;
}
function gatePassed(gate: ReleaseGateId, d: Record<string, unknown>, input: ReleaseReadinessInput): boolean {
  switch (gate) {
    case "evaluation":
      return d.suiteVersion === "keystone.evaluation/1" && positive(d.repetitions) && (d.repetitions as number) >= 2 &&
        Array.isArray(d.modes) && d.modes.length === 2 && d.modes.includes("minimal") && d.modes.includes("standard") &&
        typeof d.inputFingerprint === "string" && /^[0-9a-f]{64}$/.test(d.inputFingerprint) &&
        positive(d.runs) && (d.runs as number) >= (d.repetitions as number) * 2 &&
        d.falseCompletions === 0 && d.scopeEscapes === 0 && d.infrastructureFailures === 0 &&
        d.replayInconsistent === 0 && Array.isArray(d.missingMetrics) && d.missingMetrics.every(text);
    case "source_clean": return d.dirty === false && d.sourceCommit === input.sourceCommit && d.sourceDigest === input.sourceDigest;
    case "macos_universal":
      return commandPassed(d) && d.platform === "darwin" && Array.isArray(d.architectures) &&
        d.architectures.includes("arm64") && d.architectures.includes("x86_64") && d.nativeLaunch === true;
    case "embedded_node": return commandPassed(d) && d.selfContained === true && text(d.nodeVersion);
    case "macos_signing":
      return commandPassed(d) && d.platform === "darwin" && d.verified === true &&
        text(d.teamId) && text(d.identity) && d.identity !== "-" && /Developer ID Application:/.test(d.identity);
    case "notarization":
      return d.platform === "darwin" && d.status === "Accepted" && d.stapled === true && text(d.ticketId) && text(d.teamId);
    case "live_provider":
      return text(d.provider) && !/scripted|mock|fixture|local/i.test(d.provider) && d.network === true &&
        text(d.endpointHost) && !["local", "localhost", "127.0.0.1", "[::1]"].includes(d.endpointHost) &&
        positive(d.checks) && d.failures === 0 && positive(d.tokens);
    case "windows": return commandPassed(d) && d.platform === "win32" && d.nativeLaunch === true;
    case "hosted_ci": {
      if (!commandPassed(d) || d.hosted !== true || !text(d.runId) || d.sourceCommit !== input.sourceCommit || !text(d.runUrl)) return false;
      const url = new URL(d.runUrl);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    }
    case "release_approval": return d.approved === true && d.actor === "user" && text(d.decisionId) && d.releaseVersion === input.releaseVersion;
    default: return commandPassed(d);
  }
}
/** Validates supplied evidence only. Does not sign, notarize, run CI or authorize a release. */
export async function checkReleaseReadiness(raw: unknown, options: ReadinessOptions): Promise<ReadinessScorecard> {
  const input = inputSchema.parse(raw);
  const root = await realpath(options.root);
  const now = options.now ?? new Date();
  const maxAge = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(maxAge) || maxAge <= 0) throw new Error("invalid evidence time policy");
  const ids = new Set<string>();
  for (const gate of input.gates) {
    if (ids.has(gate.gateId)) throw new Error("duplicate gate");
    ids.add(gate.gateId);
  }
  const gates: ReadinessScorecard["gates"] = [];
  for (const gateId of STABLE_GATES) {
    const claim = input.gates.find((gate) => gate.gateId === gateId);
    const row: ReadinessScorecard["gates"][number] = {
      gateId, status: "missing", requiredFor: (LOCAL_GATES as readonly string[]).includes(gateId) ? "local" : "stable",
      evidenceDigest: null, reason: "No hash-addressed evidence supplied.",
    };
    if (claim?.status === "failed" || claim?.status === "blocked") {
      row.status = claim.status;
      row.reason = "Explicit nonpassing input; never upgraded by evidence.";
    } else if (claim?.status === "passed" && claim.evidence !== undefined) {
      try {
        if (claim.evidence.path !== `artifacts/${claim.evidence.sha256}.json`) throw new Error("evidence address mismatch");
        const bytes = await boundedFile(root, claim.evidence.path);
        if (sha256Bytes(bytes) !== claim.evidence.sha256) throw new Error("evidence digest mismatch");
        const report = evidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
        const observed = Date.parse(report.observedAt);
        if (report.gateId !== gateId || report.status !== "passed" ||
            Object.keys(binding).some((field) => report[field as keyof typeof binding] !== input[field as keyof typeof binding]) ||
            !Number.isFinite(observed) || observed > now.getTime() || now.getTime() - observed > maxAge ||
            !gatePassed(gateId, detailsOf(report.details), input)) throw new Error("gate evidence binding or checks rejected");
        row.status = "passed";
        row.evidenceDigest = claim.evidence.sha256;
        row.reason = "Supplied report bytes, release binding, freshness and gate-specific checks validated.";
      } catch {
        row.status = "invalid";
        row.reason = "Evidence missing, unsafe, tampered, stale, mismatched or insufficient.";
      }
    }
    gates.push(row);
  }
  const channel = input.releaseVersion.includes("-") ? "rc" : "stable";
  return {
    version: "keystone.release-readiness-result/1", ...Object.fromEntries(Object.keys(binding).map((field) =>
      [field, input[field as keyof typeof binding]])) as Pick<ReadinessScorecard, keyof typeof binding>,
    generatedAt: now.toISOString(), channel,
    localReady: gates.filter((gate) => gate.requiredFor === "local").every((gate) => gate.status === "passed"),
    stableReady: channel === "stable" && gates.every((gate) => gate.status === "passed"), gates,
    limits: ["Supplied evidence is not independently authenticated; protect its producer and storage.",
      "No external services called; no release, signing, notarization or provider success inferred.",
      "RC local readiness never implies stable readiness. A release still requires explicit user authorization.",
      "Concurrent hostile filesystem mutation requires OS isolation."],
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input") throw new Error("usage: readiness.ts --input /path/readiness-input.json");
  const inputPath = resolve(args[1]!);
  if (!inputPath.endsWith("/readiness-input.json") && !inputPath.endsWith("\\readiness-input.json")) throw new Error("input must be readiness-input.json");
  const root = await realpath(dirname(inputPath));
  const bytes = await boundedFile(root, "readiness-input.json");
  const card = await checkReleaseReadiness(JSON.parse(bytes.toString("utf8")), { root });
  process.stdout.write(JSON.stringify(card, null, 2) + "\n");
  if (!(card.channel === "rc" ? card.localReady : card.stableReady)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("release readiness input rejected; no passing gates asserted\n"); process.exitCode = 1; });
}
