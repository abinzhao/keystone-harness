/**
 * Governed local/project Agent Skills (ADR-0009).
 *
 * Read-only, progressive-disclosure inspection of on-disk SKILL.md directories.
 * Discovery grants nothing and runs no script; bodies and resources load on
 * demand as untrusted input.
 */

export * from "./frontmatter.ts";
export * from "./loader.ts";
