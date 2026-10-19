/**
 * `keystone protocol export` — versioned JSON Schema export (PRD ST-03).
 *
 * The schemas written here are derived from the same validators the kernel
 * enforces (`toJsonSchema()`), so an external client or another language can
 * negotiate against a definition that cannot drift from the authority
 * (PRD NFR-COMP-05).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listSchemas } from "@keystone/schemas";

import { getBoolean, parseArgs, requireString, UsageError } from "../args.ts";
import { createOutput } from "../output.ts";
import { translatorForContext, type CliContext, type CommandModule } from "./shared.ts";

async function run(argv: readonly string[], context: CliContext): Promise<number> {
  const sub = argv[0];
  if (sub !== "export") {
    throw new UsageError(`unknown subcommand "protocol ${sub ?? ""}"; expected "protocol export"`);
  }
  const args = parseArgs(argv.slice(1), {
    flags: { out: "string", json: "boolean", verbose: "boolean" },
  });
  const output = createOutput({
    stdout: context.stdout,
    stderr: context.stderr,
    json: getBoolean(args, "json"),
    verbose: getBoolean(args, "verbose"),
  });
  const t = translatorForContext(context);
  const outDir = requireString(args, "out");

  await mkdir(outDir, { recursive: true });

  const schemas = listSchemas();
  const index: { id: string; version: string; file: string }[] = [];
  for (const schema of schemas) {
    const file = `${schema.id}@${schema.version}.json`;
    await writeFile(join(outDir, file), `${JSON.stringify(schema.toJsonSchema(), null, 2)}\n`);
    index.push({ id: schema.id, version: schema.version, file });
  }
  await writeFile(
    join(outDir, "index.json"),
    `${JSON.stringify({ count: index.length, schemas: index }, null, 2)}\n`,
  );

  output.line(t("Exported {count} protocol schema(s) to {dir}.", { count: index.length, dir: outDir }));
  for (const entry of index) output.detail(`${entry.id}@${entry.version} -> ${entry.file}`);
  output.json({ out: outDir, count: index.length, schemas: index });
  return 0;
}

export const command: CommandModule = {
  name: "protocol",
  summary: (t) => t("Export the protocol's JSON Schema definitions"),
  usage: "keystone protocol export --out <dir> [--json]",
  help: [
    "keystone protocol export --out <dir>",
    "",
    "  Write every Keystone Run Protocol schema as JSON Schema, one file per",
    "  `<id>@<version>.json`, plus an index.json. The output is byte-for-byte",
    "  derived from the validators the runtime enforces.",
  ].join("\n"),
  run,
};
