/**
 * Runnable local checker.
 *
 * Usage:
 *   node src/cli.ts <source.json> <target.json> [<target.json> ...]
 *
 * Exit code 0 when every target keeps the source's placeholders; 1 on any
 * parity finding; 2 on a usage or read error. It is deliberately a thin wrapper
 * over the pure checker so the E1 verifier adapter and the CLI agree exactly on
 * what "parity" means.
 *
 * Offline and side-effect-free: it only reads the files named on the command
 * line and prints to stdout/stderr.
 */

import { readFile } from "node:fs/promises";

import { checkCatalogParity, parseCatalog, type MessageCatalog } from "./checker.ts";

function usage(): never {
  process.stderr.write(
    "usage: localization-placeholders-check <source.json> <target.json> [target.json ...]\n",
  );
  process.exit(2);
}

async function readCatalog(path: string): Promise<MessageCatalog> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) {
    process.stderr.write(`error: could not read ${path}\n`);
    process.exit(2);
  }
  const catalog = parseCatalog(raw as string);
  if (catalog === undefined) {
    process.stderr.write(`error: ${path} is not a flat string->string JSON catalog\n`);
    process.exit(2);
  }
  return catalog as MessageCatalog;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [sourcePath, ...targetPaths] = argv;
  if (sourcePath === undefined || targetPaths.length === 0) usage();

  const source = await readCatalog(sourcePath);
  let failed = false;

  for (const targetPath of targetPaths) {
    const target = await readCatalog(targetPath);
    const findings = checkCatalogParity(source, target);
    if (findings.length === 0) {
      process.stdout.write(`ok: ${targetPath} preserves placeholders\n`);
      continue;
    }
    failed = true;
    process.stdout.write(`fail: ${targetPath}\n`);
    for (const finding of findings) {
      process.stdout.write(`  - [${finding.kind}] ${finding.detail}\n`);
    }
  }

  return failed ? 1 : 0;
}

// When run directly (not imported by a test), execute. Node strips types here.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("cli.ts");
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    });
}
