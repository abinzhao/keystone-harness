/**
 * `@keystone/extension-no-debug-statements` — a reference Keystone extension.
 *
 * Load it the way a host would: read the manifest, verify integrity, run the
 * conformance kit, and only then let it near a task. See
 * `packages/extension-no-debug-statements/test/extension.test.ts` for the whole
 * sequence against the real activation gate.
 */

export { REFERENCE_EXTENSION, buildManifest, loadDeclaration } from "./manifest.ts";
export {
  FINDING_PATTERNS,
  noDebugStatementsVerifier,
  scanForDebugStatements,
  type DebugFinding,
} from "./verifier.ts";
