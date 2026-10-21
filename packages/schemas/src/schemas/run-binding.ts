import { arrayOf, defineSchema, enumOf, int, lit, nonEmptyStr, objectOf, optional, type InferSchema } from "../validate.ts";
import { configurationSnapshotSchema } from "./attachment.ts";
import { sha256Validator } from "./ids.ts";

/** Local recovery input, content addressed and referenced by checkpoint events.
 * v1 is additive; old tasks remain readable but cannot resume without a binding.
 * Model credentials and attachment bodies are deliberately excluded.
 */
export const runBindingSchema = defineSchema("keystone.runtime.runBinding", "1.0.0", objectOf({
  schemaVersion: lit("keystone.runtime.runBinding@1.0.0"),
  workspacePath: nonEmptyStr(),
  workPath: nonEmptyStr(),
  mode: enumOf(["minimal", "standard", "isolated", "replay"] as const),
  request: nonEmptyStr(),
  baselineFingerprint: sha256Validator,
  baselineFiles: arrayOf(objectOf({ path: nonEmptyStr(), hash: sha256Validator }), { maxItems: 100_000 }),
  baselineDirtyPaths: arrayOf(nonEmptyStr(), { maxItems: 100_000 }),
  maxSteps: int({ min: 1, max: 1000 }),
  tokenBudgetPerStep: optional(int({ min: 1 })),
  configurationSnapshot: optional(configurationSnapshotSchema.validator),
  executionFingerprint: sha256Validator,
}));
export type RunBinding = InferSchema<typeof runBindingSchema>;
