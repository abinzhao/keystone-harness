/**
 * `@keystone/extension-localization-placeholders` — a reference Keystone extension.
 *
 * A non-engineering reference scenario: it proves a translated message catalog
 * keeps every placeholder the source uses and invents none. Load it the way a
 * host would — read the manifest, verify integrity, run the conformance kit
 * (including the generic verifier-entry shape probe), and only then let it near a
 * task. See `test/extension.test.ts` for the whole sequence against the real
 * activation gate.
 *
 * The entry export is the governed E1 verifier adapter. The same pure checker also
 * backs the runnable CLI (`src/cli.ts`), so the governed check and the local
 * check never disagree.
 */

export { REFERENCE_EXTENSION, buildManifest, loadDeclaration } from "./manifest.ts";
export {
  extractPlaceholders,
  parseCatalog,
  checkCatalogParity,
  catalogParityHolds,
  type MessageCatalog,
  type PlaceholderFinding,
  type PlaceholderFindingKind,
} from "./checker.ts";
export {
  localizationPlaceholdersVerifier,
  SOURCE_CATALOG,
  describesLocaleFile,
  localeName,
} from "./verifier.ts";
export { localizationParityE2Verifier } from "./e2-verifier.ts";
export { compileLocalizationContract } from "./contract.ts";
export { main as runCli } from "./cli.ts";
