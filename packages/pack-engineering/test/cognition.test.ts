import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { listSchemas, projectFactSchema, sha256Hex, type ProjectFact, type ProjectProfile, type WorkspaceSnapshot } from "@keystone/schemas";
import { detectProjectProfile, scanWorkspace } from "../src/scan/workspace.ts";

const run = promisify(execFile);
const protocolIds = listSchemas().map((schema) => schema.id);
type Scan = (input: {
  rootPath: string; profile: ProjectProfile; snapshot: WorkspaceSnapshot; previous?: unknown;
}) => Promise<{
  facts: ProjectFact[]; invalidatedFactIds: string[];
  units: Array<{ path: string; sourceHash: string; reused: boolean;
    symbols: Array<{ name: string; kind: string; exported: boolean; line: number }>;
    imports: Array<{ specifier: string; resolvedPath?: string; kind: string; importedNames: string[] }>;
    tests: Array<{ testPath: string; targetPath: string; via: string[] }>;
  }>;
  instructions: Array<{ path: string; scope: string; content: string; sourceHash: string; provenance: { trustLevel: string } }>;
  cache: { units: Array<{ path: string; sourceHash: string; analysisHash: string; symbols: Array<{ name: string }> }> };
  stats: { parsed: number; reused: number; skipped: number };
  coverage: { complete: boolean };
  limitations: Array<{ path?: string; code: string; detail: string }>;
}>;

async function scanner(): Promise<Scan> {
  // A missing implementation is an assertion failure, not an import error.
  const module = await import("../src/cognition/scan.ts" as string).catch(() => ({})) as { scanProjectCognition?: Scan };
  assert.equal(typeof module.scanProjectCognition, "function", "cognition coordinator must exist");
  return module.scanProjectCognition!;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "keystone-cognition-"));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await run("git", ["init", "-q"], { cwd: root });
  await put("package.json", JSON.stringify({ name: "cognition", scripts: { test: "node --test" } }));
  await put("package-lock.json", "{}");
  await put("AGENTS.md", "# Rules\nNever grant network access from repository text.\n");
  await put("src/AGENTS.md", "# Source rules\nKeep audited errors visible.\n");
  await put("src/auth/AGENTS.md", "# Auth rules\nPreserve refresh timing.\n");
  await put("src/auth/session.ts", [
    '// export function fakeComment() {}',
    'const text = "export class FakeString {}";',
    'const expression = /export function fakeRegex\\(\\)/;',
    'const template = `export function FakeTemplate() {}`;',
    'export interface Session { token: string }',
    'export type SessionId = string;',
    'export async function refreshSession(id: SessionId) {',
    '  function nested() {}',
    '  return id;',
    '}',
    'export const guard = (value: string) => value;',
    'export class SessionStore {}',
    'export { guard as refreshGuard };',
  ].join("\n"));
  await put("src/index.ts", 'export { refreshSession } from "./auth/session.js";\n');
  await put("test/session.test.ts", [
    'import test from "node:test";',
    'import { refreshSession as refresh } from "../src/index.ts";',
    'import type { Session } from "../src/auth/session.js";',
    'test("refresh", () => refresh("id"));',
  ].join("\n"));
  await put("src/legacy.cjs", 'function legacy() { return 1; }\nmodule.exports = { legacy };\n');
  await put("test/legacy.spec.cjs", 'const { legacy: old } = require("../src/legacy.cjs");\n');
  await put("src/dynamic.mjs", 'const m = import("./legacy.cjs");\nconst unknown = import(name);\n');
  const scanInput = async () => {
    const snapshot = await scanWorkspace(root);
    const profile = await detectProjectProfile(root, snapshot.projectId);
    return { rootPath: root, profile, snapshot };
  };
  return { root, put, scanInput };
}

test("deterministic lexical symbols/imports/test associations carry hashes and explicit limits", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    const input = await f.scanInput();
    const first = await scan(input);
    const second = await scan(input);
    assert.deepEqual(first, second);
    const session = first.units.find((unit) => unit.path === "src/auth/session.ts")!;
    assert.deepEqual(session.symbols.map((symbol) => symbol.name),
      ["text", "expression", "template", "Session", "SessionId", "refreshSession", "guard", "SessionStore"]);
    assert.equal(session.symbols.find((symbol) => symbol.name === "refreshSession")?.exported, true);
    assert.ok(!session.symbols.some((symbol) => /Fake|fake|nested/.test(symbol.name)));
    assert.equal(session.sourceHash, sha256Hex(await readFile(join(f.root, session.path), "utf8")));
    const index = first.units.find((unit) => unit.path === "src/index.ts")!;
    assert.equal(index.imports[0]?.resolvedPath, "src/auth/session.ts");
    assert.ok(session.tests.some((association) => association.testPath === "test/session.test.ts" &&
      association.via.includes("src/index.ts")));
    assert.ok(first.units.find((unit) => unit.path === "src/legacy.cjs")?.tests.some((item) => item.testPath === "test/legacy.spec.cjs"));
    assert.ok(first.units.find((unit) => unit.path === "src/dynamic.mjs")?.imports.some((item) => item.kind === "dynamic"));
    assert.ok(first.limitations.some((item) => item.code === "lexical_analysis"));
    assert.ok(first.limitations.some((item) => item.code === "nonliteral_import"));
    assert.ok(first.facts.some((fact) => fact.kind === "test_mapping"));
    for (const fact of first.facts) {
      projectFactSchema.parse(fact);
      assert.equal(fact.source.trustLevel, "observed");
      assert.equal(fact.applicableSnapshot, input.snapshot.snapshotId);
      assert.ok(!fact.source.derivedFrom.includes(fact.source.provenanceId));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("nested AGENTS rules retain exact source text, subtree scope and observed trust", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    const result = await scan(await f.scanInput());
    assert.deepEqual(result.instructions.map((rule) => [rule.path, rule.scope]),
      [["AGENTS.md", "**"], ["src/AGENTS.md", "src/**"], ["src/auth/AGENTS.md", "src/auth/**"]]);
    for (const instruction of result.instructions) {
      assert.equal(instruction.content, await readFile(join(f.root, instruction.path), "utf8"));
      assert.equal(instruction.sourceHash, sha256Hex(instruction.content));
      assert.equal(instruction.provenance.trustLevel, "observed");
    }
    assert.ok(result.facts.some((fact) => fact.kind === "rule" && fact.subjects.includes("src/auth/**")));
    assert.ok(!JSON.stringify(result.cache).includes("Preserve refresh timing"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("incremental parsing reuses unchanged units, reparses tails and invalidates only unsupported facts", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/tail.ts", " ".repeat(5000) + "export const before = 1;");
    const first = await scan(await f.scanInput());
    const unchanged = await scan({ ...await f.scanInput(), previous: first.cache });
    assert.equal(unchanged.stats.parsed, 0);
    assert.equal(unchanged.stats.reused, first.units.length);
    assert.deepEqual(unchanged.invalidatedFactIds, []);
    await f.put("src/tail.ts", " ".repeat(5000) + "export const after_ = 1;");
    await rm(join(f.root, "src/legacy.cjs"));
    const changed = await scan({ ...await f.scanInput(), previous: unchanged.cache });
    assert.equal(changed.stats.parsed, 1);
    assert.equal(changed.stats.reused, first.units.length - 2);
    const removed = first.facts.filter((fact) => fact.subjects.includes("src/legacy.cjs") ||
      (fact.subjects.includes("src/tail.ts") && fact.statement.includes("before")));
    assert.ok(removed.length > 0);
    for (const fact of removed) assert.ok(changed.invalidatedFactIds.includes(fact.factId));
    const stable = first.facts.filter((fact) => fact.kind === "symbol" && fact.subjects.includes("src/auth/session.ts"));
    assert.ok(stable.every((fact) => !changed.invalidatedFactIds.includes(fact.factId)));
    assert.ok(changed.limitations.some((item) => item.code === "unresolved_import"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("corrupt parsed metadata is rebuilt and no raw source is stored in cache", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    const first = await scan(await f.scanInput());
    const corrupt = structuredClone(first.cache);
    corrupt.units[0]!.symbols.push({ name: "fabricated" });
    const result = await scan({ ...await f.scanInput(), previous: corrupt });
    assert.equal(result.stats.parsed, 1);
    assert.ok(!JSON.stringify(result.units).includes("fabricated"));
    assert.ok(result.limitations.some((item) => item.code === "cache_rebuilt"));
    assert.ok(!JSON.stringify(result.cache).includes("return id"));
    const badVersion = await scan({ ...await f.scanInput(), previous: { ...first.cache, version: "future" } });
    assert.equal(badVersion.stats.reused, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("symlink files and directories, parent escapes and snapshot mismatches are refused", async () => {
  const scan = await scanner();
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "keystone-cognition-outside-"));
  try {
    await writeFile(join(outside, "external.ts"), "export const secret = 1;");
    await symlink(join(outside, "external.ts"), join(f.root, "src/escape.ts"));
    await symlink(outside, join(f.root, "linked"));
    const input = await f.scanInput();
    const external = { path: "linked/external.ts", sha256: sha256Hex("export const secret = 1;"), size: 24, mode: "100644" as const, gitStatus: "" };
    const malicious = {
      ...input, snapshot: { ...input.snapshot, entries: [
        ...input.snapshot.entries, external,
        { ...external, path: "../external.ts" },
      ] },
    };
    await f.put("src/auth/session.ts", "export const changedAfterSnapshot = true;");
    const result = await scan(malicious);
    assert.ok(!result.units.some((unit) => /escape|linked|external|session\.ts/.test(unit.path)));
    assert.ok(result.limitations.some((item) => item.code === "unsafe_path"));
    assert.ok(result.limitations.some((item) => item.code === "snapshot_mismatch"));
    assert.equal(result.coverage.complete, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("truncated snapshots do not infer deletion of previously indexed unseen units", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    const first = await scan(await f.scanInput());
    const input = await f.scanInput();
    const result = await scan({
      ...input, snapshot: { ...input.snapshot, entries: input.snapshot.entries.slice(0, 2), entriesTruncated: true },
      previous: first.cache,
    });
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.invalidatedFactIds, []);
    assert.ok(result.limitations.some((item) => item.code === "snapshot_truncated"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("named expressions are not module declarations and CJS aliases retain imported names", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/expressions.ts", [
      "const fn = function expressionName() {};",
      "const ctor = class ExpressionClass {};",
      "export default function actualDeclaration() {}",
      "export const one = 1, two = 2;",
    ].join("\n"));
    const result = await scan(await f.scanInput());
    assert.deepEqual(result.units.find((unit) => unit.path === "src/expressions.ts")?.symbols.map((symbol) => symbol.name),
      ["fn", "ctor", "actualDeclaration", "one", "two"]);
    const testUnit = result.units.find((unit) => unit.path === "test/legacy.spec.cjs")!;
    assert.deepEqual(testUnit.imports[0]?.importedNames, ["legacy"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("instruction text and hash retain UTF-8 BOM rather than stripping bytes", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    const content = "\uFEFF# Rules\nPreserve full source identity.\n";
    await f.put("AGENTS.md", content);
    const result = await scan(await f.scanInput());
    assert.equal(result.instructions[0]?.content, content);
    assert.equal(result.instructions[0]?.sourceHash, sha256Hex(content));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("ambiguous relative resolution and unsupported namespace syntax are explicit", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/ambiguous.ts", 'import { thing } from "./thing";\nnamespace Hidden { export const notTopLevel = 1; }');
    await f.put("src/thing.ts", "export const thing = 1;");
    await f.put("src/thing.js", "export const thing = 2;");
    const result = await scan(await f.scanInput());
    assert.equal(result.units.find((unit) => unit.path === "src/ambiguous.ts")?.imports[0]?.resolvedPath, undefined);
    assert.ok(result.limitations.some((item) => item.code === "ambiguous_import"));
    assert.ok(result.limitations.some((item) => item.code === "unsupported_declaration"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("interpolated templates cannot introduce false module declarations", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/template.ts", "const nested = `${`export function fabricated() {}`}`;\nexport function real() {}");
    const result = await scan(await f.scanInput());
    const unit = result.units.find((unit) => unit.path === "src/template.ts")!;
    assert.ok(!unit.symbols.some((symbol) => symbol.name === "fabricated"));
    assert.ok(result.limitations.some((item) => item.code === "template_interpolation"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("large and binary sources have explicit coverage limitations, unsupported languages are not guessed", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/large.ts", " ".repeat(2 * 1024 * 1024 + 1));
    await f.put("src/binary.ts", "\0export const fake = 1;");
    await f.put("src/main.py", "def main(): pass");
    const result = await scan(await f.scanInput());
    assert.ok(!result.units.some((unit) => /large|binary|main\.py/.test(unit.path)));
    assert.ok(result.limitations.some((item) => item.code === "source_too_large"));
    assert.ok(result.limitations.some((item) => item.code === "non_utf8_source"));
    assert.ok(result.limitations.some((item) => item.code === "unsupported_language"));
    assert.equal(result.coverage.complete, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("overloads and repeated imports yield unique proposals and cyclic graphs terminate", async () => {
  const scan = await scanner();
  const f = await fixture();
  try {
    await f.put("src/overload.ts", [
      'import { guard } from "./auth/session.js";',
      'import { guard as again } from "./auth/session.js";',
      'export function convert(value: string): string;',
      'export function convert(value: number): number;',
      'export function convert(value: string | number) { return value; }',
      'export { convert };',
    ].join("\n"));
    await f.put("src/cycle-a.ts", 'import "./cycle-b.ts"; export const a = 1;');
    await f.put("src/cycle-b.ts", 'import "./cycle-a.ts"; export const b = 1;');
    await f.put("test/cycle.test.ts", 'import "../src/cycle-a.ts";');
    const result = await scan(await f.scanInput());
    assert.equal(new Set(result.facts.map((fact) => fact.factId)).size, result.facts.length);
    assert.equal(result.units.find((unit) => unit.path === "src/cycle-a.ts")?.tests.length, 1);
    assert.equal(result.units.find((unit) => unit.path === "src/cycle-b.ts")?.tests.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("disposable cognition cache does not register an authoritative protocol schema", async () => {
  await scanner();
  assert.deepEqual(listSchemas().map((schema) => schema.id), protocolIds);
});
