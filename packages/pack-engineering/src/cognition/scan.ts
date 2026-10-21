/**
 * Snapshot-bound engineering cognition. Reads source, never executes it or
 * writes authoritative facts. The returned proposals must enter KernelSession.
 * Cache storage is caller-owned and contains parsed metadata, not source bodies.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep, posix } from "node:path";
import {
  arrayOf, bool, canonicalJson, derivedIdBody, enumOf, int,
  nonEmptyStr, objectOf, optional, projectFactSchema, sha256Bytes, sha256Hex, str,
  type InferValidator, type ProjectFact, type ProjectProfile, type ProvenanceRef,
  type SnapshotEntry, type WorkspaceSnapshot,
} from "@keystone/schemas";
import {
  COGNITION_PARSER_VERSION, parseSourceUnit,
  type CognitionImport, type CognitionLimitation, type ParsedSourceUnit,
} from "./parser.ts";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".keystone", "node_modules", "dist", "build", "coverage"]);
export const COGNITION_CACHE_VERSION = "engineering-cognition@1";
const hashValidator = str({ pattern: /^[a-f0-9]{64}$/ });
const symbolValidator = objectOf({
  name: nonEmptyStr(), kind: enumOf(["function", "class", "interface", "type", "variable"] as const),
  line: int({ min: 1 }), exported: bool(),
});
const importValidator = objectOf({
  specifier: nonEmptyStr(), kind: enumOf(["static", "reexport", "require", "dynamic"] as const),
  line: int({ min: 1 }), importedNames: arrayOf(nonEmptyStr()), typeOnly: bool(),
});
const limitationValidator = objectOf({ path: optional(nonEmptyStr()), code: nonEmptyStr(), detail: nonEmptyStr() });
const cacheUnitValidator = objectOf({
  path: nonEmptyStr(), sourceHash: hashValidator, analysisHash: hashValidator,
  symbols: arrayOf(symbolValidator), imports: arrayOf(importValidator),
  exports: arrayOf(objectOf({ name: nonEmptyStr(), localName: str(), line: int({ min: 1 }) })),
  limitations: arrayOf(limitationValidator),
});
export const cognitionCacheSchema = objectOf({
  version: nonEmptyStr(), parserVersion: nonEmptyStr(), projectId: nonEmptyStr(), rootHash: hashValidator,
  units: arrayOf(cacheUnitValidator, { maxItems: 100_000 }),
  facts: arrayOf(objectOf({ factId: nonEmptyStr(), subjects: arrayOf(nonEmptyStr()) })),
});
export type CognitionCache = InferValidator<typeof cognitionCacheSchema>;
const cacheHeaderValidator = objectOf({
  version: nonEmptyStr(), parserVersion: nonEmptyStr(), projectId: nonEmptyStr(), rootHash: hashValidator,
});

export interface CognitionTestAssociation {
  readonly testPath: string;
  readonly targetPath: string;
  /** Observed import path, including test and target; no coverage claim. */
  readonly via: readonly string[];
}
export interface ResolvedCognitionImport extends CognitionImport {
  readonly resolvedPath?: string;
  readonly resolution: "relative" | "external" | "unresolved" | "ambiguous";
}
export interface CognitionUnit extends ParsedSourceUnit {
  readonly path: string;
  readonly sourceHash: string;
  readonly reused: boolean;
  readonly imports: readonly ResolvedCognitionImport[];
  readonly tests: readonly CognitionTestAssociation[];
}
export interface CognitionInstruction {
  readonly path: string;
  readonly scope: string;
  readonly sourceHash: string;
  readonly content: string;
  readonly provenance: ProvenanceRef;
}
export interface ScanProjectCognitionInput {
  readonly rootPath: string;
  readonly profile: ProjectProfile;
  readonly snapshot: WorkspaceSnapshot;
  readonly previous?: unknown;
}
export interface CognitionScanResult {
  readonly facts: readonly ProjectFact[];
  readonly invalidatedFactIds: readonly string[];
  readonly units: readonly CognitionUnit[];
  readonly instructions: readonly CognitionInstruction[];
  readonly cache: CognitionCache;
  readonly stats: {
    readonly scanned: number; readonly parsed: number; readonly reused: number; readonly skipped: number;
  };
  readonly coverage: {
    /** Complete file coverage within snapshot exclusions, not semantic completeness. */
    readonly complete: boolean; readonly snapshotTruncated: boolean;
    readonly snapshotEntries: number; readonly sourceUnits: number;
  };
  readonly limitations: readonly CognitionLimitation[];
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function safePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    !/^[a-z]:/i.test(path) && !path.split("/").some((part) => part === "." || part === ".." || part === "");
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(rel).startsWith(`${sep}${sep}`);
}
function analysisHash(unit: ParsedSourceUnit): string {
  return sha256Hex(canonicalJson({
    parserVersion: COGNITION_PARSER_VERSION,
    symbols: unit.symbols, imports: unit.imports, exports: unit.exports, limitations: unit.limitations,
  }));
}

class SourceReadError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.code = code; }
}
async function readSnapshotSource(root: string, entry: SnapshotEntry): Promise<string> {
  if (!safePath(entry.path)) throw new SourceReadError("unsafe_path", "Absolute, parent, empty-component or non-POSIX source path refused.");
  if (entry.mode === "120000" || entry.mode === "160000") throw new SourceReadError("unsafe_path", "Symlink or submodule source refused.");
  if (entry.size > MAX_SOURCE_BYTES) throw new SourceReadError("source_too_large", `Source exceeds ${MAX_SOURCE_BYTES} bytes.`);
  let current = root;
  let before;
  const parts = entry.path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new SourceReadError("unsafe_path", "Symlink source or ancestor refused.");
    if (index < parts.length - 1 && !info.isDirectory()) throw new SourceReadError("unsafe_path", "Non-directory source ancestor refused.");
    if (index === parts.length - 1) before = info;
  }
  if (before === undefined || !before.isFile()) throw new SourceReadError("unsafe_path", "Non-regular source refused.");
  const canonical = await realpath(current);
  if (!within(root, canonical)) throw new SourceReadError("unsafe_path", "Source resolves outside project root.");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_SOURCE_BYTES || opened.ino !== before.ino || opened.dev !== before.dev ||
        await realpath(current) !== canonical) throw new SourceReadError("unsafe_path", "Source identity changed during open.");
    const bytes = await handle.readFile();
    const after = await lstat(current);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev ||
        await realpath(current) !== canonical || bytes.length !== entry.size ||
        sha256Bytes(bytes) !== entry.sha256) throw new SourceReadError("snapshot_mismatch", "Source no longer matches the supplied snapshot.");
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("binary");
      return text;
    } catch { throw new SourceReadError("non_utf8_source", "Binary or invalid UTF-8 source is not analyzed."); }
  } finally { await handle.close(); }
}

/** Resolve only relative imports against safely read snapshot units. */
function resolveImport(path: string, entry: CognitionImport, paths: ReadonlySet<string>): ResolvedCognitionImport {
  if (!entry.specifier.startsWith(".")) return { ...entry, resolution: "external" };
  const target = posix.normalize(posix.join(posix.dirname(path), entry.specifier));
  if (!safePath(target)) return { ...entry, resolution: "unresolved" };
  if (paths.has(target)) return { ...entry, resolution: "relative", resolvedPath: target };
  const extension = posix.extname(target);
  const replacements: Record<string, readonly string[]> = {
    ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
  };
  let candidates: string[];
  if (extension === "") candidates = [
    ...SOURCE_EXTENSIONS.map((ext) => target + ext),
    ...SOURCE_EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  else candidates = (replacements[extension] ?? []).map((ext) => target.slice(0, -extension.length) + ext);
  const matches = [...new Set(candidates.filter((candidate) => paths.has(candidate)))];
  return matches.length === 1 ? { ...entry, resolution: "relative", resolvedPath: matches[0]! } :
    { ...entry, resolution: matches.length > 1 ? "ambiguous" : "unresolved" };
}

function provenance(snapshot: WorkspaceSnapshot, path: string, hash: string): ProvenanceRef {
  return {
    provenanceId: `prov_${derivedIdBody(`${snapshot.projectId}:${path}:${hash}`)}` as never,
    sourceKind: "repository", trustLevel: "observed", locator: path,
    applicableSnapshot: snapshot.snapshotId, derivedFrom: [],
    invalidatedBy: [`workspace.changed:${path}`], observedAt: snapshot.at,
    transformation: "deterministic-lexical-cognition",
    extended: { sourceHash: hash, analyzerVersion: COGNITION_PARSER_VERSION },
  };
}

export async function scanProjectCognition(input: ScanProjectCognitionInput): Promise<CognitionScanResult> {
  if (input.profile.projectId !== input.snapshot.projectId) throw new Error("cognition profile/snapshot project mismatch");
  const root = await realpath(resolve(input.rootPath));
  if (await realpath(resolve(input.profile.rootPath)) !== root) throw new Error("cognition profile root mismatch");
  const rootHash = sha256Hex(root);
  const limitations: CognitionLimitation[] = [
    { code: "lexical_analysis", detail: "Module-level ASCII TS/JS declarations and literal imports only; no type checking, symbol binding, call graph, execution or verified test coverage." },
    { code: "resolution_limits", detail: "Relative imports resolve only to safely read snapshot sources. Package exports, tsconfig aliases, conditional exports and runtime loaders are not resolved." },
    { code: "snapshot_scope", detail: `Only supplied snapshot entries are analyzed; excluded paths: ${input.snapshot.excluded.join(", ") || "none"}. Ignored instruction files are not inferred.` },
    { code: "instruction_trust", detail: "AGENTS.md applies to its directory subtree; text is retained as observed repository constraints, never permission or authority. Conflicts are not silently overridden." },
  ];
  const unsupportedLanguages = input.profile.languages.filter((language) =>
    !["typescript", "javascript", "markdown"].includes(language));
  if (unsupportedLanguages.length > 0) limitations.push({
    code: "unsupported_language", detail: `No symbol/import analysis for: ${unsupportedLanguages.join(", ")}.`,
  });
  if (input.snapshot.entriesTruncated) limitations.push({
    code: "snapshot_truncated", detail: "Snapshot entries are truncated; unseen previous units are retained in cache and no deletion is inferred.",
  });
  let previous: CognitionCache | undefined;
  if (input.previous !== undefined) {
    try {
      const raw = input.previous as Record<string, unknown>;
      const header = cacheHeaderValidator.parse({
        version: raw["version"], parserVersion: raw["parserVersion"], projectId: raw["projectId"], rootHash: raw["rootHash"],
      });
      if (header.version !== COGNITION_CACHE_VERSION || header.parserVersion !== COGNITION_PARSER_VERSION ||
          header.projectId !== input.snapshot.projectId || header.rootHash !== rootHash ||
          !Array.isArray(raw["units"]) || !Array.isArray(raw["facts"])) throw new Error("cache identity mismatch");
      const recovered: CognitionCache["units"][number][] = [];
      for (const rawUnit of raw["units"]) {
        try { recovered.push(cacheUnitValidator.parse(rawUnit)); } catch {
          limitations.push({ code: "cache_rebuilt", detail: "Malformed parsed unit ignored; unaffected units remain reusable." });
        }
      }
      previous = cognitionCacheSchema.parse({ ...header, units: recovered, facts: raw["facts"] });
    } catch {
      limitations.push({ code: "cache_rebuilt", detail: "Invalid or incompatible cache ignored; current snapshot sources are reparsed." });
    }
  }
  const cached = new Map(previous?.units.map((unit) => [unit.path, unit]) ?? []);
  const cacheUnits: CognitionCache["units"][number][] = [];
  const parsedUnits: Array<ParsedSourceUnit & { path: string; sourceHash: string; reused: boolean }> = [];
  const instructions: CognitionInstruction[] = [];
  const seen = new Set<string>();
  let parsed = 0;
  let reused = 0;
  let skipped = 0;
  for (const entry of [...input.snapshot.entries].sort((a, b) => compare(a.path, b.path))) {
    if (seen.has(entry.path)) {
      limitations.push({ path: entry.path, code: "duplicate_entry", detail: "Duplicate snapshot path ignored." }); skipped += 1; continue;
    }
    seen.add(entry.path);
    if (entry.path.split("/").some((part) => SKIP_DIRECTORIES.has(part))) continue;
    const isInstruction = basename(entry.path) === "AGENTS.md";
    const isSource = SOURCE_EXTENSIONS.includes(extname(entry.path));
    if (!isInstruction && !isSource) continue;
    let text: string;
    try { text = await readSnapshotSource(root, entry); } catch (error) {
      limitations.push({
        path: entry.path, code: error instanceof SourceReadError ? error.code : "source_unavailable",
        detail: error instanceof SourceReadError ? error.message : "Source unavailable or changed during scan.",
      });
      skipped += 1;
      continue;
    }
    if (isInstruction) {
      const directory = dirname(entry.path).split(sep).join("/");
      instructions.push({
        path: entry.path, scope: directory === "." ? "**" : `${directory}/**`,
        content: text, sourceHash: entry.sha256, provenance: provenance(input.snapshot, entry.path, entry.sha256),
      });
      continue;
    }
    let analysis: ParsedSourceUnit;
    const old = cached.get(entry.path);
    const hit = old !== undefined && old.sourceHash === entry.sha256 && old.analysisHash === analysisHash(old);
    if (hit) {
      analysis = { symbols: old.symbols, imports: old.imports, exports: old.exports, limitations: old.limitations };
      reused += 1;
    } else {
      if (old !== undefined && old.sourceHash === entry.sha256) limitations.push({
        path: entry.path, code: "cache_rebuilt", detail: "Parsed metadata digest mismatch; unit reparsed from current bytes.",
      });
      analysis = parseSourceUnit(text);
      if ([".tsx", ".jsx"].includes(extname(entry.path))) {
        analysis = { ...analysis, limitations: [...analysis.limitations,
          { code: "jsx_partial", detail: "JSX markup may contain syntax outside this lexical analyzer; module-level index is partial." }] };
      }
      parsed += 1;
    }
    cacheUnits.push({ path: entry.path, sourceHash: entry.sha256, ...analysis, analysisHash: analysisHash(analysis) });
    parsedUnits.push({ path: entry.path, sourceHash: entry.sha256, ...analysis, reused: hit });
    limitations.push(...analysis.limitations.map((item) => ({ ...item, path: entry.path })));
  }
  const paths = new Set(parsedUnits.map((unit) => unit.path));
  const units: CognitionUnit[] = parsedUnits.map((unit) => {
    const imports = unit.imports.map((entry) => resolveImport(unit.path, entry, paths));
    for (const entry of imports) {
      if (entry.resolution === "unresolved" || entry.resolution === "ambiguous") limitations.push({
        path: unit.path, code: entry.resolution === "ambiguous" ? "ambiguous_import" : "unresolved_import",
        detail: `${entry.specifier} at line ${entry.line} has no unique safely scanned source target.`,
      });
    }
    return { ...unit, imports, tests: [] };
  });
  const unitsByPath = new Map(units.map((unit) => [unit.path, unit]));
  const associations = new Map<string, CognitionTestAssociation[]>();
  for (const unit of units) {
    if (!/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(unit.path)) continue;
    const visited = new Set<string>([unit.path]);
    const queue = [{ path: unit.path, via: [unit.path] }];
    for (let index = 0; index < queue.length; index += 1) {
      const next = queue[index]!;
      for (const edge of unitsByPath.get(next.path)?.imports ?? []) {
        if (edge.typeOnly || edge.resolvedPath === undefined || visited.has(edge.resolvedPath)) continue;
        visited.add(edge.resolvedPath);
        const via = [...next.via, edge.resolvedPath];
        const association = { testPath: unit.path, targetPath: edge.resolvedPath, via };
        const list = associations.get(edge.resolvedPath) ?? [];
        list.push(association); associations.set(edge.resolvedPath, list);
        queue.push({ path: edge.resolvedPath, via });
      }
    }
  }
  const mappedUnits = units.map((unit) => ({ ...unit, tests: associations.get(unit.path) ?? [] }));
  const facts: ProjectFact[] = [];
  const factsById = new Map<string, ProjectFact>();
  const propose = (kind: ProjectFact["kind"], key: string, statement: string, subjects: string[],
    path: string, hash: string, upstream: readonly ProjectFact[] = []): ProjectFact => {
    const factId = `fact_${derivedIdBody(`${input.snapshot.projectId}:${kind}:${key}`)}`;
    const existing = factsById.get(factId);
    if (existing !== undefined) return existing;
    const source = provenance(input.snapshot, path, hash);
    const fact = projectFactSchema.parse({
      factId,
      projectId: input.snapshot.projectId, kind, statement,
      source: {
        ...source,
        provenanceId: `prov_${derivedIdBody(`${factId}:${source.provenanceId}`)}` as never,
        derivedFrom: [...new Set([source.provenanceId, ...upstream.map((fact) => fact.source.provenanceId)])].slice(0, 64),
        invalidatedBy: [...new Set(subjects.map((path) => `workspace.changed:${path}`))].slice(0, 32),
      },
      derivedFrom: upstream.map((fact) => fact.factId).slice(0, 64),
      applicableSnapshot: input.snapshot.snapshotId,
      invalidatedBy: [...new Set(subjects.map((path) => `workspace.changed:${path}`))].slice(0, 32),
      status: "active", observedAt: input.snapshot.at, updatedAt: input.snapshot.at, subjects: subjects.slice(0, 64),
    });
    facts.push(fact);
    factsById.set(factId, fact);
    return fact;
  };
  const moduleFacts = new Map<string, ProjectFact>();
  for (const unit of mappedUnits) moduleFacts.set(unit.path,
    propose("module", unit.path, `TS/JS source module: ${unit.path} (lexical analysis)`, [unit.path], unit.path, unit.sourceHash));
  for (const unit of mappedUnits) {
    for (const symbol of unit.symbols) propose("symbol", `${unit.path}:${symbol.kind}:${symbol.name}`,
      `${symbol.exported ? "Exported" : "Module-local"} ${symbol.kind} ${symbol.name} at ${unit.path}:${symbol.line}`,
      [unit.path], unit.path, unit.sourceHash, [moduleFacts.get(unit.path)!]);
    for (const edge of unit.imports) propose("dependency", `${unit.path}:${edge.kind}:${edge.specifier}:${edge.resolvedPath ?? ""}`,
      `${edge.kind}${edge.typeOnly ? " type-only" : ""} import ${JSON.stringify(edge.specifier)} at ${unit.path}:${edge.line}` +
        ` (${edge.resolution}${edge.resolvedPath === undefined ? "" : `: ${edge.resolvedPath}`})`,
      [unit.path, ...(edge.resolvedPath === undefined ? [] : [edge.resolvedPath])],
      unit.path, unit.sourceHash,
      [moduleFacts.get(unit.path)!, ...(edge.resolvedPath === undefined ? [] : [moduleFacts.get(edge.resolvedPath)!])]);
    for (const association of unit.tests) {
      if (association.via.length > 64) {
        limitations.push({ path: unit.path, code: "association_too_deep", detail: "Test import path exceeds fact provenance limits; association fact omitted." });
        continue;
      }
      propose("test_mapping", `${association.testPath}:${unit.path}`,
        `Import-associated test ${association.testPath} reaches ${unit.path} via ${association.via.join(" -> ")}; not verified coverage.`,
        [...association.via], association.testPath, unitsByPath.get(association.testPath)!.sourceHash,
        association.via.map((path) => moduleFacts.get(path)!));
    }
  }
  for (const instruction of instructions) propose("rule", instruction.path,
    `Repository constraints from ${instruction.path} (scope ${instruction.scope}; sha256 ${instruction.sourceHash}):\n${instruction.content}`,
    [instruction.path, instruction.scope], instruction.path, instruction.sourceHash);
  facts.sort((a, b) => compare(a.factId, b.factId));
  const ids = new Set<string>(facts.map((fact) => fact.factId));
  const invalidatedFactIds = input.snapshot.entriesTruncated ? [] :
    (previous?.facts ?? []).filter((fact) => !ids.has(fact.factId)).map((fact) => fact.factId).sort(compare);
  if (input.snapshot.entriesTruncated) {
    for (const unit of previous?.units ?? []) if (!seen.has(unit.path)) cacheUnits.push(unit);
  }
  const manifest = new Map((input.snapshot.entriesTruncated ? previous?.facts ?? [] : []).map((fact) => [fact.factId, fact]));
  for (const fact of facts) manifest.set(fact.factId, { factId: fact.factId, subjects: [...fact.subjects] });
  const cache = cognitionCacheSchema.parse({
    version: COGNITION_CACHE_VERSION, parserVersion: COGNITION_PARSER_VERSION,
    projectId: input.snapshot.projectId, rootHash, units: cacheUnits.sort((a, b) => compare(a.path, b.path)),
    facts: [...manifest.values()].sort((a, b) => compare(a.factId, b.factId)),
  });
  return {
    facts, invalidatedFactIds: [...new Set(invalidatedFactIds)], units: mappedUnits, instructions, cache,
    stats: { scanned: parsedUnits.length + instructions.length, parsed, reused, skipped },
    coverage: {
      complete: !input.snapshot.entriesTruncated && skipped === 0,
      snapshotTruncated: input.snapshot.entriesTruncated, snapshotEntries: input.snapshot.entries.length,
      sourceUnits: parsedUnits.length,
    },
    limitations: [...new Map(limitations.map((item) => [canonicalJson(item), item])).values()],
  };
}
