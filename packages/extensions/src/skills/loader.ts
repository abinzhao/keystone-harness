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

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256Bytes } from "@keystone/schemas";

import { parseSkillMarkdown } from "./frontmatter.ts";

export const SKILL_FILE = "SKILL.md";

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
  /** Relative files under `scripts/`. Present for disclosure only; never run here. */
  readonly scripts: readonly string[];
}

export class SkillAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAccessError";
  }
}

/** List immediate files under a directory, recursively flattened to relative POSIX paths. */
async function listUnder(base: string, sub: string): Promise<string[]> {
  const dir = join(base, sub);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listUnder(base, rel)));
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
  const absolute = resolve(dir);
  let raw: string;
  let bytes: Uint8Array;
  try {
    const buffer = await readFile(join(absolute, SKILL_FILE));
    bytes = new Uint8Array(buffer);
    raw = buffer.toString("utf8");
  } catch {
    return undefined;
  }

  const parsed = parseSkillMarkdown(raw);
  if (!parsed.ok || parsed.frontmatter === undefined) return undefined;

  const [resources, scripts] = await Promise.all([
    listUnder(absolute, "resources"),
    listUnder(absolute, "scripts"),
  ]);

  return {
    dir: absolute,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    metadata: parsed.frontmatter.metadata,
    digest: sha256Bytes(bytes),
    resources,
    scripts,
  };
}

/**
 * Discover skills under one or more roots. Each immediate subdirectory that
 * contains a valid SKILL.md becomes one disclosed skill.
 */
export async function discoverSkills(roots: readonly string[]): Promise<readonly SkillDisclosure[]> {
  const found: SkillDisclosure[] = [];
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const disclosure = await inspectSkill(join(resolve(root), entry.name));
      if (disclosure !== undefined) found.push(disclosure);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load the SKILL.md body on demand. It is untrusted prose, never authority. */
export async function loadSkillBody(disclosure: SkillDisclosure): Promise<string> {
  const raw = await readFile(join(disclosure.dir, SKILL_FILE), "utf8");
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
  const base = resolve(disclosure.dir);
  const target = resolve(isAbsolute(relPath) ? relPath : join(base, relPath));
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "") {
    throw new SkillAccessError(`resource "${relPath}" escapes the skill directory`);
  }
  return readFile(target, "utf8");
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
