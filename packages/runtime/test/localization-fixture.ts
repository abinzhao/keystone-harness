/**
 * Localization placeholder-parity acceptance fixture.
 *
 * A real, offline Git repository whose own test suite checks that the Chinese
 * message catalog keeps every placeholder the English source uses. Nothing is
 * mocked: the E2 test verifier runs this project's `npm test` in a child
 * process, and that test reads the catalogs from disk.
 *
 * The fixture is deliberately self-contained (CommonJS, no node_modules): the
 * parity rule it inlines is the same deterministic rule implemented, governed
 * and unit-tested in `@keystone/extension-localization-placeholders`.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveKeystonePaths } from "@keystone/kernel";

export const run = promisify(execFile);

/** Source (English) catalog: the contract every translation is measured against. */
export const EN_CATALOG = {
  greeting: "Hello {name}, you have {count} new messages",
  checkout: "Order total: {{total}}",
  empty: "Nothing here",
};

/**
 * The broken translation that ships in the baseline commit: it drops `{count}`
 * from the greeting and omits the `empty` message entirely. The parity test must
 * fail against this, which is what makes the baseline honest.
 */
export const BROKEN_ZH_CATALOG = {
  greeting: "你好 {name}，有新消息",
  checkout: "订单总额：{{total}}",
};

/** A plausible-but-wrong repair: reads better, but still drops {count}. */
export const WRONG_ZH_CATALOG = {
  greeting: "你好 {name}，有新消息",
  checkout: "订单总额：{{total}}",
  empty: "这里空空如也",
};

/** The correct translation: same placeholder set, reordered text, nothing dropped. */
export const FIXED_ZH_CATALOG = {
  greeting: "你好 {name}，你有 {count} 条新消息",
  checkout: "订单总额：{{total}}",
  empty: "这里空空如也",
};

/**
 * The project's own test. Inlined CommonJS so the fixture has no dependencies.
 * It implements the same parity rule as the extension's pure checker: per key,
 * the placeholder sets must be equal, and there must be no orphan translations.
 */
const PARITY_TEST = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const { readFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  "",
  "function placeholders(message) {",
  "  const names = new Set();",
  '  const re = /\\{\\{\\s*([A-Za-z0-9_]+)\\s*\\}\\}|\\{\\s*([A-Za-z0-9_]+)\\s*\\}/g;',
  "  let match;",
  "  while ((match = re.exec(message)) !== null) names.add(match[1] || match[2]);",
  "  return names;",
  "}",
  "",
  'test("the zh catalog preserves every source placeholder", () => {',
  '  const root = join(__dirname, "..");',
  '  const en = JSON.parse(readFileSync(join(root, "locales", "en.json"), "utf8"));',
  '  const zh = JSON.parse(readFileSync(join(root, "locales", "zh.json"), "utf8"));',
  "  for (const [key, source] of Object.entries(en)) {",
  '    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `missing translation for "${key}"`);',
  "    const src = placeholders(source);",
  "    const dst = placeholders(zh[key] || \"\");",
  "    for (const name of src) assert.ok(dst.has(name), `\"${key}\" drops the {${name}} placeholder`);",
  "    for (const name of dst) assert.ok(src.has(name), `\"${key}\" invents the {${name}} placeholder`);",
  "  }",
  "  for (const key of Object.keys(zh)) {",
  '    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `orphan translation "${key}"`);',
  "  }",
  "});",
  "",
].join("\n");

export interface LocalizationFixture {
  readonly root: string;
  readonly home: string;
  readonly paths: ReturnType<typeof resolveKeystonePaths>;
}

export async function makeLocalizationFixture(): Promise<LocalizationFixture> {
  const root = await mkdtemp(join(tmpdir(), "keystone-locfixture-"));
  const home = join(root, ".keystone-home");

  await mkdir(join(root, "locales"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "locales", "en.json"), JSON.stringify(EN_CATALOG, null, 2));
  await writeFile(join(root, "locales", "zh.json"), JSON.stringify(BROKEN_ZH_CATALOG, null, 2));
  await writeFile(join(root, "test", "parity.test.js"), PARITY_TEST);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      { name: "loc-fixture", version: "1.0.0", scripts: { test: "node --test" } },
      null,
      2,
    ),
  );
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

  // A real local repo, fully offline: no remote, no credentials.
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "loc@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Loc"], { cwd: root });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-q", "-m", "initial: broken zh catalog"], { cwd: root });

  return { root, home, paths: resolveKeystonePaths(home) };
}

export async function removeLocalizationFixture(fixture: LocalizationFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Run the fixture's own test suite, stripping NODE_TEST_CONTEXT like the acceptance helper. */
export async function localizationTestsPass(root: string): Promise<boolean> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "NODE_TEST_CONTEXT") continue;
    if (value !== undefined) env[key] = value;
  }
  try {
    await run("npm", ["run", "test"], { cwd: root, env });
    return true;
  } catch {
    return false;
  }
}

/** Write a catalog the way a scripted builder would. */
export function writeCatalogAction(path: string, catalog: Record<string, string>): Record<string, unknown> {
  return {
    intent: "write",
    tool: "fs.write_file",
    parameters: { path, content: `${JSON.stringify(catalog, null, 2)}\n` },
    rationale: `update the translation in ${path}`,
    expected_effects: [{ kind: "file_modify", target: path, description: "parity-preserving translation" }],
    requested_capabilities: ["fs.write"],
    produces_evidence_for: [],
    reversibility: "reversible",
  };
}

export const FINISH = {
  intent: "finish",
  tool: "fs.read_file",
  parameters: {},
  rationale: "the translation is in place",
  expected_effects: [],
  requested_capabilities: [],
  produces_evidence_for: [],
  reversibility: "reversible",
} as const;
