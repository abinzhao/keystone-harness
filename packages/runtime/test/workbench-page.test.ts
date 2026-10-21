/**
 * Structural guards only. Selection/draft/conflict behavior is exercised by
 * workbench-client.test.ts; actual layout/focus QA belongs to browser acceptance.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { workbench } from "../../i18n/src/catalog/zh-CN/workbench.ts";

const read = (path: string) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");

test("the shell loads confined native modules and keeps named project/task navigation", async () => {
  const html = await read("workbench.html");
  assert.match(html, /type="module" src="\/assets\/client\/main.js"/);
  assert.match(html, /href="\/assets\/styles\/workbench.css"/);
  for (const id of ["project-select", "task-select", "sidebar-toggle", "inspector-toggle", "settings-button", "command-button"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /<img\b|https?:\/\/|data-mode="simple"/);
});

test("accessible shell includes native labelled dialogs, live status and keyboard separators", async () => {
  const html = await read("workbench.html");
  assert.match(html, /<dialog id="modal" aria-labelledby="modal-title"/);
  assert.match(html, /id="connection" role="status"/);
  assert.match(html, /id="error" role="alert"/);
  assert.match(html, /role="separator" tabindex="0" aria-orientation="vertical"/);
  assert.match(html, /href="#workspace-main"/);
});

test("responsive drawers preserve navigation and support themes, density and reduced motion", async () => {
  const css = await read("styles/workbench.css");
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /data-theme="dark"/);
  assert.match(css, /data-density="compact"/);
  assert.match(css, /@media \(max-width: 999px\)/);
  assert.match(css, /@media \(max-width: 699px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /minmax\(0, 1fr\)/);
});

test("catalog markers cover the shell and no inline execution remains", async () => {
  const html = await read("workbench.html");
  assert.match(html, /data-i18n="Projects"/);
  assert.match(html, /data-i18n(?:-aria)?="Tasks"/);
  assert.match(html, /data-i18n="Settings"/);
  assert.doesNotMatch(html, /onclick=|<script>(?!<\/script>)/);
});

test("onboarding retains native password entry and all four protocol choices", async () => {
  const html = await read("workbench.html");
  assert.match(html, /id="onboarding"/);
  assert.match(html, /id="ob-key" type="password"/);
  for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"]) {
    assert.ok(html.includes(`value="${protocol}"`), protocol);
  }
});

test("reference shell has full-height brand navigation, centered welcome and modal settings", async () => {
  const html = await read("workbench.html");
  const sidebar = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('id="sidebar-resize"'));
  assert.match(sidebar, /class="brand"/);
  assert.match(sidebar, /id="new-task"/);
  assert.match(sidebar, /id="connection"/);
  for (const view of ["extensions", "cognition", "lab", "collaboration", "readiness"]) {
    assert.ok(sidebar.includes(`data-page="${view}"`), view);
  }
  assert.match(html, /id="welcome"/);
  assert.match(html, /<dialog id="settings-modal" aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-host"/);
  const css = await read("styles/workbench.css");
  assert.match(css, /--sidebar: 27[0-9]px/);
  assert.match(css, /max-width: 900px/);
  assert.match(css, /grid-row: 1 \/ -1/);
  assert.match(css, /\.app\.welcome/);
  assert.match(css, /\.theme-tiles/);
});

test("every literal workbench presentation key has a Chinese catalog entry", async () => {
  const root = new URL("../web/", import.meta.url);
  const paths = await readdir(root, { recursive: true });
  const keys = new Set<string>();
  const helpers = new Set(["tr", "text", "button", "field", "selectField", "note", "jsonDetails", "kv"]);
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) keys.add(node.text);
    else if (ts.isConditionalExpression(node)) { collect(node.whenTrue); collect(node.whenFalse); }
    else if (ts.isParenthesizedExpression(node)) collect(node.expression);
  };
  for (const path of paths.filter((path) => path.endsWith(".js"))) {
    const source = await readFile(new URL(path, root), "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text) && node.arguments[0]) collect(node.arguments[0]);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "dialogs") {
        if (node.arguments[0]) collect(node.arguments[0]);
        if (node.expression.name.text === "prompt" && node.arguments[1]) collect(node.arguments[1]);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "emptyProjection" && node.arguments[3]) collect(node.arguments[3]);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "servicePage" && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
        for (const property of node.arguments[1].properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ["title", "description"].includes(property.name.text)) collect(property.initializer);
        }
      }
      if (ts.isArrayLiteralExpression(node) && ts.isArrayLiteralExpression(node.parent) && node.elements[1] && ts.isStringLiteral(node.elements[1]) && /^[A-Z]/.test(node.elements[1].text)) keys.add(node.elements[1].text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "EVENTS" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) if (ts.isPropertyAssignment(property)) collect(property.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  for (const key of [
    "Too many attachments (maximum 10).", "Unsupported attachment type.", "Image exceeds 20 MiB.", "Text exceeds 10 MiB.",
    "Image input is not declared for every routed model. Remove images or explicitly configure a compatible route; no automatic cloud fallback.",
    "Chinese", "English", "Comfortable", "Compact", "Follow system", "Light", "Dark",
    "Stable model ID", "Provider", "Credential handle (not a secret)", "Context tokens",
    "Confirm attachment egress", "Send these attachments", "Review contract revision", "Confirm the scope of this task",
    "Start task (I accept this scope)", "Discard settings draft", "Discard draft", "Real provider request",
    "Confirm requested permission", "Rename file", "Destination path", "Relative file path", "Delete file",
    "Discard unsaved file edits", "Discard draft and undo", "Clean rebuildable cache", "Clean cache", "Migrate local data", "Migrate data",
  ]) keys.add(key);
  const html = await read("workbench.html");
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) keys.add(match[1]!);
  const missing = [...keys].filter((key) => !Object.hasOwn(workbench, key)).sort();
  assert.deepEqual(missing, [], `Missing presentation keys:\n${missing.join("\n")}`);
});
