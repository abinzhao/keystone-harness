/**
 * Workspace scanning and project profiling (PRD PI-01).
 *
 * Two constraints shape this file:
 *
 *  - Keystone never copies user source into its own store; a snapshot keeps only
 *    path metadata and a content digest, so the store cannot leak the working
 *    tree (ADR-0005, PRD 12.4).
 *  - The fingerprint must cover the *entire* scan even when `entries` is
 *    truncated, so a cheap equality check stays available on large repositories
 *    and evidence invalidation (VF-06) can trust it.
 */

import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import {
  canonicalJson,
  newId,
  nowIso,
  projectProfileSchema,
  sha256Bytes,
  sha256Hex,
  workspaceSnapshotSchema,
  type ProjectId,
  type ProjectProfile,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "@keystone/schemas";

// Storage-layout and scope primitives stay owned by the kernel (ADR-0005); this
// pack consumes them rather than re-implementing the on-disk layout.
import {
  globToRegExp,
  projectIdForWorkspace,
  readJsonFile,
} from "@keystone/kernel";

/**
 * Non-Git workspaces are refused outright in the first release: recovery,
 * branching and evidence invalidation all assume a Git work tree (PRD PI-01).
 */
export class NotAGitRepositoryError extends Error {
  readonly rootPath: string;
  constructor(rootPath: string) {
    super(`"${rootPath}" is not a Git repository; Keystone requires a Git work tree`);
    this.name = "NotAGitRepositoryError";
    this.rootPath = rootPath;
  }
}

const DEFAULT_EXCLUSIONS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".keystone",
  "coverage",
  "*.log",
] as const;

const DEFAULT_MAX_ENTRIES = 20_000;
const PROFILE_FILE_LIMIT = 5_000;
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".swift": "swift",
  ".md": "markdown",
};

export interface ScanWorkspaceOptions {
  readonly exclusions?: readonly string[];
  readonly maxEntries?: number;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * Run git with an argument array — never a shell string. Repository paths and
 * user-selected exclusions must not be able to become shell syntax.
 */
function runGit(rootPath: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["-C", rootPath, ...args],
      { encoding: "utf8", maxBuffer: MAX_GIT_BUFFER },
      (error, stdout) => {
        if (error !== null) resolvePromise({ ok: false, stdout: "" });
        else resolvePromise({ ok: true, stdout: String(stdout) });
      },
    );
  });
}

export async function scanWorkspace(
  rootPath: string,
  options: ScanWorkspaceOptions = {},
): Promise<WorkspaceSnapshot> {
  const root = resolve(rootPath);

  const topLevelResult = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.ok) throw new NotAGitRepositoryError(root);
  const topLevel = topLevelResult.stdout.trim() === "" ? root : topLevelResult.stdout.trim();

  const exclusions = [...DEFAULT_EXCLUSIONS, ...(options.exclusions ?? [])];
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const headResult = await runGit(root, ["rev-parse", "HEAD"]);
  const headCommit = headResult.ok && headResult.stdout.trim() !== "" ? headResult.stdout.trim() : undefined;
  const branchResult = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.ok && branchResult.stdout.trim() !== "" ? branchResult.stdout.trim() : undefined;

  const tracked = splitNul((await runGit(root, ["ls-files", "-z"])).stdout);
  const untracked = new Set(splitNul((await runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"])).stdout));
  const statusByPath = parsePorcelainStatus((await runGit(root, ["status", "--porcelain", "-z"])).stdout);
  const modeByPath = parseIndexModes((await runGit(root, ["ls-files", "-s", "-z"])).stdout);

  const candidates = new Set<string>([...tracked, ...untracked]);
  const excluded = new Set<string>();

  const entries: SnapshotEntry[] = [];
  const digestPairs: Array<[string, string]> = [];
  let totalBytes = 0;
  let untrackedCount = 0;
  let dirty = false;

  for (const path of [...candidates].sort()) {
    const matched = exclusionMatch(path, exclusions);
    if (matched !== undefined) {
      excluded.add(matched);
      continue;
    }

    const gitStatus = untracked.has(path) ? "?" : (statusByPath.get(path) ?? "");
    if (gitStatus !== "") dirty = true;
    if (gitStatus === "?") untrackedCount += 1;

    let bytes: Buffer;
    try {
      bytes = await readFile(join(topLevel, path));
    } catch {
      // A tracked file that was deleted from the work tree cannot be digested;
      // the porcelain status still records the change for `dirty`.
      continue;
    }

    const sha256 = sha256Bytes(new Uint8Array(bytes));
    totalBytes += bytes.byteLength;
    entries.push({
      path,
      size: bytes.byteLength,
      sha256,
      mode: normaliseMode(modeByPath.get(path)),
      gitStatus,
    });
    digestPairs.push([path, sha256]);
  }

  const entryCount = entries.length;
  const entriesTruncated = entryCount > maxEntries;
  const storedEntries = entriesTruncated ? entries.slice(0, maxEntries) : entries;

  const snapshot = workspaceSnapshotSchema.parse({
    snapshotId: newId("snap"),
    projectId: await projectIdForWorkspace(topLevel),
    at: nowIso(),
    ...(headCommit === undefined ? {} : { headCommit }),
    ...(branch === undefined ? {} : { branch }),
    dirty,
    untrackedCount,
    entries: storedEntries,
    entriesTruncated,
    entryCount,
    totalBytes,
    excluded: [...excluded].sort(),
    // The fingerprint covers every scanned entry, not just the stored prefix, so
    // it stays a reliable change detector even when storage was truncated.
    fingerprint: sha256Hex(canonicalJson(digestPairs)),
  }) as WorkspaceSnapshot;

  return snapshot;
}

/**
 * List the worktree's dirty and untracked paths, relative to the repo root.
 *
 * This is the cheap admission probe behind ADR-0012 Decision F: before a
 * standard run may start, the runtime compares this set against the task's
 * write scope and refuses to clobber overlapping uncommitted work. It is
 * deliberately *not* a full `scanWorkspace` (which digests every file): for
 * admission we only need which paths are dirty, so we run two porcelain/ls
 * commands instead of reading the whole tree. A non-Git workspace is refused
 * here the same way a full scan refuses it.
 */
export async function listDirtyPaths(rootPath: string): Promise<readonly string[]> {
  const root = resolve(rootPath);
  const topLevelResult = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.ok) throw new NotAGitRepositoryError(root);
  const topLevel = topLevelResult.stdout.trim() === "" ? root : topLevelResult.stdout.trim();

  // With `-z`, a rename/copy record is `XY <orig> -> <dest>\0` — a single
  // record whose path part already names the rewritten destination. The path a
  // write would touch is the destination, so we split on ` -> `.
  const status = splitNul((await runGit(topLevel, ["status", "--porcelain", "-z"])).stdout);
  const dirty = new Set<string>();
  for (const record of status) {
    if (record === "") continue;
    const pathPart = record.slice(3);
    const arrow = pathPart.indexOf(" -> ");
    dirty.add(arrow === -1 ? pathPart : pathPart.slice(arrow + 4));
  }
  return [...dirty].sort();
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

/**
 * Parse `git status --porcelain -z`: records are `XY<space>path\0`, and a
 * rename/copy record is followed by the original path as its own NUL record.
 */
function parsePorcelainStatus(output: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry === undefined || entry === "") continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.startsWith("R") || xy.startsWith("C")) index += 1; // skip the source path
    map.set(path, normaliseStatus(xy));
  }
  return map;
}

function normaliseStatus(xy: string): string {
  if (xy === "??") return "?";
  return xy.trim();
}

/** Parse `git ls-files -s -z`: `<mode> <object> <stage>\t<path>\0`. */
function parseIndexModes(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of splitNul(output)) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    const mode = meta[0];
    const path = record.slice(tab + 1);
    if (mode !== undefined && path !== "") map.set(path, mode);
  }
  return map;
}

function normaliseMode(mode: string | undefined): string {
  if (mode === "100644" || mode === "100755" || mode === "120000" || mode === "160000") {
    return mode;
  }
  return "100644";
}

/** Which exclusion pattern removed `path`, if any. Returns the matched pattern. */
function exclusionMatch(path: string, patterns: readonly string[]): string | undefined {
  const name = basename(path);
  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?")) {
      const matcher = globToRegExp(pattern);
      if (matcher.test(path) || matcher.test(name)) return pattern;
      continue;
    }
    const prefix = pattern.replace(/\/+$/, "");
    if (path === prefix || path.startsWith(`${prefix}/`)) return pattern;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Project profile
// ---------------------------------------------------------------------------

type CommandKind = "build" | "test" | "typecheck" | "lint" | "run";

/**
 * Only `typecheck` gets aliases: `type-check` and a bare `tsc` are common, but
 * inventing commands for the others would violate PI-01 §4 ("no guessed values").
 */
const SCRIPT_ALIASES: Record<CommandKind, readonly string[]> = {
  build: ["build"],
  test: ["test"],
  typecheck: ["typecheck", "type-check", "tsc"],
  lint: ["lint"],
  run: ["run"],
};

const COMMAND_KINDS: readonly CommandKind[] = ["build", "test", "typecheck", "lint", "run"];
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursor/rules"] as const;

export async function detectProjectProfile(
  rootPath: string,
  projectId: ProjectId,
): Promise<ProjectProfile> {
  const root = resolve(rootPath);

  const pkg = await readJsonFile<Record<string, unknown>>(join(root, "package.json")).catch(
    () => undefined,
  );
  const hasPackageJson = pkg !== undefined;

  const packageManager = await detectPackageManager(root);
  const languageCounts = await collectExtensions(root, PROFILE_FILE_LIMIT);
  const languages = [...languageCounts.keys()].sort();

  const scripts = readScripts(pkg);
  const commands = COMMAND_KINDS.map((kind) => buildCommand(kind, scripts));

  const instructionFiles: string[] = [];
  for (const file of INSTRUCTION_FILES) {
    if (await pathExists(join(root, file))) instructionFiles.push(file);
  }

  const support = judgeSupport(hasPackageJson, languages);
  const rawName = pkg?.["name"];
  const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : basename(root);

  return projectProfileSchema.parse({
    projectId,
    rootPath: root,
    name,
    vcs: "git",
    languages,
    ...(packageManager === undefined ? {} : { packageManager }),
    support,
    commands,
    instructionFiles,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }) as ProjectProfile;
}

function judgeSupport(
  hasPackageJson: boolean,
  languages: readonly string[],
): ProjectProfile["support"] {
  if (!hasPackageJson) {
    return {
      status: "unsupported",
      reasons: ["no package.json was found; the project is outside the supported matrix"],
    };
  }
  if (languages.includes("typescript")) {
    return {
      status: "supported",
      reasons: ["package.json found and TypeScript sources detected"],
    };
  }
  return {
    status: "partially_supported",
    reasons: ["package.json found but no TypeScript sources detected"],
  };
}

async function detectPackageManager(root: string): Promise<string | undefined> {
  if (await pathExists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(root, "yarn.lock"))) return "yarn";
  if (await pathExists(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

function readScripts(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = pkg?.["scripts"];
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function buildCommand(
  kind: CommandKind,
  scripts: Record<string, string>,
): ProjectProfile["commands"][number] {
  for (const alias of SCRIPT_ALIASES[kind]) {
    if (Object.prototype.hasOwnProperty.call(scripts, alias)) {
      return {
        kind,
        command: `pnpm ${alias}`,
        status: "identified",
        source: `package.json#scripts.${alias}`,
      };
    }
  }
  // Unidentified commands carry no `command`: a guess here would be recorded as
  // fact and later executed (PRD PI-01 §4).
  return { kind, status: "unrecognized" };
}

/** Depth-first walk counting source extensions, capped to keep profiling cheap. */
async function collectExtensions(
  root: string,
  limit: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const queue: string[] = [""];
  let scanned = 0;

  while (queue.length > 0 && scanned < limit) {
    const relative = queue.shift() ?? "";
    const absolute = relative === "" ? root : join(root, relative);
    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (scanned >= limit) break;
      const childRelative = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
      if (exclusionMatch(childRelative, DEFAULT_EXCLUSIONS) !== undefined) continue;
      if (dirent.isDirectory()) {
        queue.push(childRelative);
        continue;
      }
      if (!dirent.isFile()) continue;
      const language = EXTENSION_LANGUAGES[extname(dirent.name).toLowerCase()];
      if (language === undefined) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
      scanned += 1;
    }
  }

  return counts;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
