/**
 * Additive workbench schemas, v1.0.0 (ADR-0014). Registry metadata is not an
 * engineering profile or kernel authority; existing project/task formats are
 * unchanged. Types and JSON Schema are derived from these validators.
 */
import {
  anyOf, arrayOf, bool, defineSchema, enumOf, int, lit, nonEmptyStr, nullable, objectOf,
  optional, str, type InferSchema,
} from "../validate.ts";
import {
  artifactIdValidator, isoTimestampValidator, projectIdValidator, sha256Validator, taskIdValidator,
} from "./ids.ts";

const projectRecordFields = {
  projectId: projectIdValidator,
  workspaceId: projectIdValidator,
  rootPath: nonEmptyStr(),
  name: str({ minLength: 1, maxLength: 256, pattern: /\S/ }),
  pinned: bool(),
  archived: bool(),
  createdAt: isoTimestampValidator,
  updatedAt: isoTimestampValidator,
} as const;

export const workbenchProjectRecordSchema = defineSchema(
  "keystone.workbench.project.record", "1.0.0", objectOf(projectRecordFields),
);
export type WorkbenchProjectRecord = InferSchema<typeof workbenchProjectRecordSchema>;

export const projectRegistrySchema = defineSchema(
  "keystone.workbench.project.registry", "1.0.0",
  objectOf({
    version: lit("1.0.0"),
    projects: arrayOf(workbenchProjectRecordSchema.validator),
  }),
);

export const projectRegisterSchema = defineSchema(
  "keystone.workbench.project.register", "1.0.0",
  objectOf({ rootPath: nonEmptyStr(), name: optional(projectRecordFields.name) }),
);
export type ProjectRegisterInput = InferSchema<typeof projectRegisterSchema>;

export const projectUpdateSchema = defineSchema(
  "keystone.workbench.project.update", "1.0.0",
  objectOf({
    name: optional(projectRecordFields.name), pinned: optional(bool()),
    archived: optional(bool()), rootPath: optional(nonEmptyStr()),
  }),
);
export type ProjectUpdateInput = InferSchema<typeof projectUpdateSchema>;

export const workbenchProjectSchema = defineSchema(
  "keystone.workbench.project", "1.0.0",
  objectOf({
    ...projectRecordFields,
    status: enumOf(["available", "missing", "unavailable"] as const),
    branch: nullable(nonEmptyStr()),
    dirty: nullable(bool()),
    scanStatus: enumOf(["not_scanned", "scanned", "unavailable"] as const),
    support: objectOf({
      status: enumOf(["unknown", "supported", "partially_supported", "unsupported"] as const),
      reasons: arrayOf(nonEmptyStr()),
    }),
    tasks: arrayOf(taskIdValidator),
    reason: optional(nonEmptyStr()),
  }),
);
export type WorkbenchProject = InferSchema<typeof workbenchProjectSchema>;

export const workbenchPathValidator = str({
  minLength: 1, maxLength: 4096,
  pattern: /^(?![\\/]|[a-z]:)(?!.*\\)(?!.*(?:^|\/)(?:\.\.|\.git)(?:\/|$))(?!.*\x00).+$/i,
  description: "workspace-relative POSIX path, excluding traversal and Git internals",
});

export const fileReadInputSchema = defineSchema(
  "keystone.workbench.file.read.input", "1.0.0", objectOf({ path: workbenchPathValidator }),
);
export type FileReadInput = InferSchema<typeof fileReadInputSchema>;

export const fileReadSchema = defineSchema(
  "keystone.workbench.file.read", "1.0.0",
  objectOf({
    path: workbenchPathValidator, content: str(), hash: sha256Validator,
    size: int({ min: 0 }), binary: bool(), truncated: bool(),
  }),
);
export type FileRead = InferSchema<typeof fileReadSchema>;

export const fileTreeInputSchema = defineSchema(
  "keystone.workbench.file.tree.input", "1.0.0",
  objectOf({
    path: optional(workbenchPathValidator), offset: optional(int({ min: 0 })),
    limit: optional(int({ min: 1, max: 1000 })),
  }),
);
export type FileTreeInput = InferSchema<typeof fileTreeInputSchema>;

export const fileEntrySchema = defineSchema(
  "keystone.workbench.file.entry", "1.0.0",
  objectOf({
    path: workbenchPathValidator, name: nonEmptyStr(),
    kind: enumOf(["file", "directory", "symlink"] as const), size: int({ min: 0 }),
    gitStatus: str({ maxLength: 8 }),
  }),
);
export type FileEntry = InferSchema<typeof fileEntrySchema>;

export const fileTreeSchema = defineSchema(
  "keystone.workbench.file.tree", "1.0.0",
  objectOf({ entries: arrayOf(fileEntrySchema.validator), nextOffset: nullable(int({ min: 0 })) }),
);
export type FileTree = InferSchema<typeof fileTreeSchema>;

export const fileSearchInputSchema = defineSchema(
  "keystone.workbench.file.search.input", "1.0.0", objectOf({ q: str({ minLength: 1, maxLength: 512 }) }),
);
export type FileSearchInput = InferSchema<typeof fileSearchInputSchema>;

export const fileSearchSchema = defineSchema(
  "keystone.workbench.file.search", "1.0.0",
  objectOf({
    results: arrayOf(objectOf({ path: workbenchPathValidator, line: int({ min: 1 }), text: str() })),
    truncated: bool(),
  }),
);
export type FileSearch = InferSchema<typeof fileSearchSchema>;

export const fileMutationIdValidator = str({ pattern: /^mut_[0-9a-f-]{36}$/ });
const mutationPath = { path: workbenchPathValidator } as const;
export const fileMutationInputSchema = defineSchema(
  "keystone.workbench.file.mutation.input", "1.0.0",
  anyOf(
    objectOf({ operation: lit("write"), ...mutationPath, content: str(), expectedHash: sha256Validator }),
    objectOf({ operation: lit("create"), ...mutationPath, content: str() }),
    objectOf({
      operation: lit("rename"), ...mutationPath, destination: workbenchPathValidator, expectedHash: sha256Validator,
    }),
    objectOf({ operation: lit("delete"), ...mutationPath, expectedHash: sha256Validator }),
    objectOf({
      operation: lit("undo"), ...mutationPath, mutationId: fileMutationIdValidator,
      expectedHash: nullable(sha256Validator),
    }),
  ),
);
export type FileMutationInput = InferSchema<typeof fileMutationInputSchema>;

export const fileMutationSchema = defineSchema(
  "keystone.workbench.file.mutation", "1.0.0",
  objectOf({
    mutationId: fileMutationIdValidator,
    operation: enumOf(["write", "create", "rename", "delete", "undo"] as const),
    ...mutationPath, destination: optional(workbenchPathValidator),
    hash: nullable(sha256Validator), artifactId: nullable(artifactIdValidator),
    changedPaths: arrayOf(workbenchPathValidator, { minItems: 1, maxItems: 2 }),
  }),
);
export type FileMutation = InferSchema<typeof fileMutationSchema>;

/** Compensating data is a runtime record, not authoritative kernel state. */
export const fileMutationRecordSchema = defineSchema(
  "keystone.workbench.file.mutation.record", "1.0.0",
  objectOf({
    mutationId: fileMutationIdValidator,
    rootPath: nonEmptyStr(),
    operation: enumOf(["write", "create", "rename", "delete"] as const),
    ...mutationPath, destination: optional(workbenchPathValidator),
    beforeHash: nullable(sha256Validator), afterHash: nullable(sha256Validator),
    artifactId: nullable(artifactIdValidator), mode: int({ min: 0, max: 0o777 }),
    undoArtifactId: optional(nullable(artifactIdValidator)),
    state: enumOf(["prepared", "applied", "undone"] as const),
  }),
);
export type FileMutationRecord = InferSchema<typeof fileMutationRecordSchema>;
