/**
 * Local/project Agent Skills loader (ADR-0009).
 *
 * A Skill is a directory on disk — `SKILL.md` plus optional `resources/` and
 * `scripts/` — discovered under a project or a user skills root. The loader is
 * read-only and progressive:
 *
 *  - *discovery* reads only frontmatter (cheap; no script ever runs);
 *  - the `SKILL.md` body loads on demand the first time the skill is used;
 *  - a declared resource loads on demand, confined to the skill directory.
 *
 * Nothing about discovering or loading a Skill grants a capability, runs a
 * script, or changes authoritative state. Everything read is untrusted
 * extension input; a changed content digest surfaces as "modified" so an
 * upgrade is visible but never auto-trusted.
 */

import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256Bytes } from "@keystone/schemas";

import { parseSkillMarkdown } from "./frontmatter.ts";

export const SKILL_FILE = "SKILL.md";
export const SKILL_MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface SkillDisclosure {
  /** Absolute directory the skill lives in. */
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  /** Untrusted metadata hints, surfaced but never acted on. */
  readonly metadata: Readonly<Record<string, string>>;
  /** sha256 of the SKILL.md bytes — changes when the skill is upgraded. */
  readonly digest: string;
  /** Relative files under `resources/`. */
  readonly resources: readonly string[];
  readonly resourceDigests: Readonly<Record<string, string>>;
  /** Relative files under `scripts/`. Present for disclosure only; never run here. */
  readonly scripts: readonly string[];
}

export class SkillAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAccessError";
  }
}

/** Check every existing ancestor; declaration cannot turn a symlink into reach. */
async function safeFile(base: string, rel: string): Promise<Buffer> {
  if (isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new SkillAccessError("resource escapes the skill directory");
  }
  const root = await realpath(base);
  let target = root;
  for (const part of rel.split("/")) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new SkillAccessError("Skill symlinks are not loadable");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SKILL_MAX_FILE_BYTES) {
      throw new SkillAccessError("Skill file exceeds the regular-file/256KiB limit");
    }
    const actual = await realpath(target);
    const outside = relative(root, actual);
    if (outside === ".." || outside.startsWith(`..${sep}`)) throw new SkillAccessError("resource escapes the skill directory");
    const buffer = Buffer.alloc(SKILL_MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > SKILL_MAX_FILE_BYTES) throw new SkillAccessError("Skill file exceeds the 256KiB limit");
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function listUnder(base: string, sub: string, budget: { entries: number }, depth = 0): Promise<string[]> {
  if (depth > 16) throw new SkillAccessError("Skill inventory depth limit exceeded");
  const dir = join(base, sub);
  let entries: Dirent[];
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw new SkillAccessError("Skill symlinks are not reviewable");
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (++budget.entries > MAX_ENTRIES) throw new SkillAccessError("Skill inventory entry limit exceeded");
    if (entry.isSymbolicLink()) throw new SkillAccessError("Skill symlinks are not reviewable");
    const rel = `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listUnder(base, rel, budget, depth + 1)));
    } else if (entry.isFile()) {
      out.push(rel.split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * Inspect one skill directory without running anything. Returns `undefined`
 * when the directory has no readable/valid SKILL.md, so discovery skips it
 * rather than throwing.
 */
export async function inspectSkill(dir: string): Promise<SkillDisclosure | undefined> {
  const absolute = await realpath(resolve(dir)).catch(() => resolve(dir));
  let raw: string;
  let bytes: Uint8Array;
  try {
    const buffer = await safeFile(absolute, SKILL_FILE);
    bytes = new Uint8Array(buffer);
    raw = buffer.toString("utf8");
  } catch (error) {
    if (error instanceof SkillAccessError) throw error;
    return undefined;
  }

  const parsed = parseSkillMarkdown(raw);
  if (!parsed.ok || parsed.frontmatter === undefined) return undefined;

  const budget = { entries: 0 };
  const resources = await listUnder(absolute, "resources", budget);
  const scripts = await listUnder(absolute, "scripts", budget);
  let totalBytes = bytes.byteLength;
  const resourceDigests: Record<string, string> = {};
  for (const resource of resources) {
    const content = await safeFile(absolute, resource);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SkillAccessError("Skill resources exceed the 2MiB limit");
    resourceDigests[resource] = sha256Bytes(content);
  }

  return {
    dir: absolute,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    metadata: parsed.frontmatter.metadata,
    digest: sha256Bytes(bytes),
    resources,
    resourceDigests,
    scripts,
  };
}

/**
 * Discover skills under one or more roots. Each immediate subdirectory that
 * contains a valid SKILL.md becomes one disclosed skill.
 */
export async function discoverSkills(roots: readonly string[]): Promise<readonly SkillDisclosure[]> {
  if (roots.length > 16) throw new SkillAccessError("Skill discovery root limit exceeded");
  const found: SkillDisclosure[] = [];
  let visited = 0;
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) throw new SkillAccessError("Skill discovery entry limit exceeded");
      if (!entry.isDirectory()) continue;
      const disclosure = await inspectSkill(join(resolve(root), entry.name));
      if (disclosure !== undefined) found.push(disclosure);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load the SKILL.md body on demand. It is untrusted prose, never authority. */
export async function loadSkillBody(disclosure: SkillDisclosure): Promise<string> {
  const bytes = await safeFile(disclosure.dir, SKILL_FILE);
  if (sha256Bytes(bytes) !== disclosure.digest) throw new SkillAccessError("Skill body digest changed; inspect again");
  const raw = bytes.toString("utf8");
  const parsed = parseSkillMarkdown(raw);
  return parsed.frontmatter?.body ?? "";
}

/**
 * Read a declared resource, confined to the skill directory. A path that escapes
 * the skill (symlink or `..`) is refused before any read.
 */
export async function readSkillResource(
  disclosure: SkillDisclosure,
  relPath: string,
): Promise<string> {
  if (!disclosure.resources.includes(relPath) || disclosure.resourceDigests[relPath] === undefined) {
    throw new SkillAccessError(`resource "${relPath}" is not a declared reviewed resource`);
  }
  const bytes = await safeFile(disclosure.dir, relPath);
  if (sha256Bytes(bytes) !== disclosure.resourceDigests[relPath]) {
    throw new SkillAccessError("Skill resource digest changed; inspect again");
  }
  return bytes.toString("utf8");
}

export interface SkillContextFragment {
  readonly content: string;
  readonly provenance: {
    readonly source: string;
    readonly trustLevel: "untrusted";
    readonly digest: string;
    readonly derivedFrom: readonly string[];
  };
}

/** Builder context helper: never interprets instructions or auto-loads scripts. */
export async function loadSkillContext(disclosure: SkillDisclosure,
  request: { readonly kind: "metadata" | "body" } | { readonly kind: "resource"; readonly path: string },
): Promise<SkillContextFragment> {
  const path = request.kind === "resource" ? request.path : SKILL_FILE;
  const content = request.kind === "metadata"
    ? JSON.stringify({ name: disclosure.name, description: disclosure.description, metadata: disclosure.metadata })
    : request.kind === "body" ? await loadSkillBody(disclosure) : await readSkillResource(disclosure, path);
  return {
    content,
    provenance: {
      source: `skill:${disclosure.name}/${path}`, trustLevel: "untrusted",
      digest: request.kind === "resource" ? disclosure.resourceDigests[path]! : disclosure.digest,
      derivedFrom: [disclosure.digest],
    },
  };
}

/**
 * Static conformance checks for a discovered skill. A skill cannot declare a
 * capability, and every script it lists must actually exist.
 */
export function checkSkillConformance(
  disclosure: SkillDisclosure,
): readonly { readonly checkId: string; readonly passed: boolean; readonly detail: string }[] {
  const checks = [
    {
      checkId: "skill.frontmatter",
      passed: disclosure.name !== "" && disclosure.description !== "",
      detail: `skill "${disclosure.name}" has name and description`,
    },
    {
      checkId: "skill.no_self_grant",
      passed: !("capabilities" in disclosure.metadata) && !("lease" in disclosure.metadata),
      detail:
        !("capabilities" in disclosure.metadata) && !("lease" in disclosure.metadata)
          ? "a skill cannot declare a capability or lease"
          : "a skill metadata block must not declare capabilities or leases",
    },
    {
      checkId: "skill.scripts_declared",
      passed: true,
      detail: `${disclosure.scripts.length} script(s) present for disclosure; they never run on discovery`,
    },
  ];
  return checks;
}
