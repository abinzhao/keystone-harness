/** Original input metadata. Binary bytes stay in content-addressed artifacts. */
import { arrayOf, defineSchema, enumOf, int, nonEmptyStr, objectOf, optional, str, type InferSchema } from "../validate.ts";
import { artifactIdValidator, isoTimestampValidator, localIdValidator, projectIdValidator, sha256Validator, taskIdValidator } from "./ids.ts";
import { provenanceRefSchema } from "./provenance.ts";

export const attachmentSchema = defineSchema("keystone.input.attachment", "1.0.0", objectOf({
  attachmentId: localIdValidator,
  projectId: projectIdValidator,
  artifactId: artifactIdValidator,
  name: str({ minLength: 1, maxLength: 255 }),
  kind: enumOf(["text", "image"] as const),
  mimeType: enumOf(["text/plain", "text/markdown", "application/json", "image/png", "image/jpeg", "image/webp"] as const),
  size: int({ min: 1, max: 20 * 1024 * 1024 }),
  contentHash: sha256Validator,
  status: enumOf(["ready", "removed"] as const),
  provenance: provenanceRefSchema.validator,
  createdAt: isoTimestampValidator,
  taskIds: arrayOf(taskIdValidator, { maxItems: 4096 }),
}));

export const configurationSnapshotSchema = defineSchema("keystone.run.configurationSnapshot", "1.0.0", objectOf({
  revision: nonEmptyStr(),
  modelIds: arrayOf(nonEmptyStr(), { maxItems: 64 }),
  builderModelId: optional(nonEmptyStr()),
}));

export type InputAttachment = InferSchema<typeof attachmentSchema>;
export type ConfigurationSnapshot = InferSchema<typeof configurationSnapshotSchema>;
