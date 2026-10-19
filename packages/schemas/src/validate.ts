/**
 * Validator combinators — the authoritative source for every Keystone schema.
 *
 * Design constraints (ADR-0004):
 *  - Zero runtime dependencies. This file replaces zod/ajv.
 *  - `toJsonSchema()` is *derived* from the same combinators that validate, so
 *    the exported machine-readable schema cannot drift from enforcement
 *    (PRD NFR-COMP-05: derived definitions come from the authoritative schema).
 *  - Errors carry a path and an expected/actual description so that a rejected
 *    Contract or Event can be explained to the user (PRD 12.3).
 */

import { canonicalJson } from "./canonical.ts";
import type { JsonValue } from "./primitives.ts";

export type JsonSchema = Record<string, unknown>;

export class SchemaValidationError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, path: string, expected: string, actual: string) {
    super(`${message} (at ${path})`);
    this.name = "SchemaValidationError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface Validator<T> {
  readonly kind: string;
  parse(input: unknown, path?: string): T;
  is(input: unknown): input is T;
  toJsonSchema(): JsonSchema;
}

export interface OptionalMarker<T> {
  readonly __optional: true;
  readonly inner: Validator<T>;
}

export type Shape = Record<string, Validator<unknown> | OptionalMarker<unknown>>;

type Infer<V> = V extends OptionalMarker<infer U>
  ? U
  : V extends Validator<infer U>
    ? U
    : never;

type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalMarker<unknown> ? never : K;
}[keyof S];

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalMarker<unknown> ? K : never;
}[keyof S];

export type InferShape<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

function describe(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "number" && Number.isInteger(input)) return `integer(${input})`;
  if (typeof input === "string") return `string(${JSON.stringify(input.slice(0, 40))})`;
  if (typeof input === "object") return "object";
  return typeof input;
}

function make<T>(
  kind: string,
  check: (input: unknown, path: string) => T,
  jsonSchema: () => JsonSchema,
): Validator<T> {
  const validator: Validator<T> = {
    kind,
    parse(input: unknown, path = "$"): T {
      return check(input, path);
    },
    is(input: unknown): input is T {
      try {
        check(input, "$");
        return true;
      } catch {
        return false;
      }
    },
    toJsonSchema(): JsonSchema {
      return jsonSchema();
    },
  };
  return validator;
}

function fail(message: string, path: string, expected: string, actual: unknown): never {
  throw new SchemaValidationError(message, path, expected, describe(actual));
}

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly description?: string;
}

export function str(options: StringOptions = {}): Validator<string> {
  return make(
    "string",
    (input, path) => {
      if (typeof input !== "string") fail("expected string", path, "string", input);
      const value = input as string;
      const min = options.minLength;
      if (min !== undefined && value.length < min) {
        fail(`string shorter than ${min}`, path, `string(minLength=${min})`, value);
      }
      const max = options.maxLength;
      if (max !== undefined && value.length > max) {
        fail(`string longer than ${max}`, path, `string(maxLength=${max})`, value);
      }
      const pattern = options.pattern;
      if (pattern !== undefined && !pattern.test(value)) {
        fail(`string does not match ${String(pattern)}`, path, `string(${String(pattern)})`, value);
      }
      return value;
    },
    () => {
      const schema: JsonSchema = { type: "string" };
      if (options.minLength !== undefined) schema["minLength"] = options.minLength;
      if (options.maxLength !== undefined) schema["maxLength"] = options.maxLength;
      if (options.pattern !== undefined) schema["pattern"] = options.pattern.source;
      if (options.description !== undefined) schema["description"] = options.description;
      return schema;
    },
  );
}

/** Non-empty, trimmed string. Rejects " " and "" which are common silent bugs. */
export function nonEmptyStr(description?: string): Validator<string> {
  return str({ minLength: 1, pattern: /\S/, ...(description === undefined ? {} : { description }) });
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly description?: string;
}

export function num(options: NumberOptions = {}): Validator<number> {
  return make(
    "number",
    (input, path) => {
      if (typeof input !== "number" || !Number.isFinite(input)) {
        fail("expected finite number", path, "number", input);
      }
      const value = input as number;
      if (options.integer === true && !Number.isInteger(value)) {
        fail("expected integer", path, "integer", value);
      }
      if (options.min !== undefined && value < options.min) {
        fail(`number below ${options.min}`, path, `number(min=${options.min})`, value);
      }
      if (options.max !== undefined && value > options.max) {
        fail(`number above ${options.max}`, path, `number(max=${options.max})`, value);
      }
      return value;
    },
    () => {
      const schema: JsonSchema = { type: options.integer === true ? "integer" : "number" };
      if (options.min !== undefined) schema["minimum"] = options.min;
      if (options.max !== undefined) schema["maximum"] = options.max;
      if (options.description !== undefined) schema["description"] = options.description;
      return schema;
    },
  );
}

export function int(options: Omit<NumberOptions, "integer"> = {}): Validator<number> {
  return num({ ...options, integer: true });
}

export function bool(): Validator<boolean> {
  return make(
    "boolean",
    (input, path) => {
      if (typeof input !== "boolean") fail("expected boolean", path, "boolean", input);
      return input as boolean;
    },
    () => ({ type: "boolean" }),
  );
}

export function lit<T extends string | number | boolean | null>(value: T): Validator<T> {
  return make(
    "literal",
    (input, path) => {
      if (input !== value) fail(`expected literal ${JSON.stringify(value)}`, path, `literal`, input);
      return value;
    },
    () => ({ const: value }),
  );
}

export function enumOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  const allowed = new Set<string>(values);
  return make(
    "enum",
    (input, path) => {
      if (typeof input !== "string" || !allowed.has(input)) {
        fail(`expected one of ${values.join(" | ")}`, path, "enum", input);
      }
      return input as T[number];
    },
    () => ({ type: "string", enum: [...values] }),
  );
}

export interface ArrayOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly description?: string;
}

export function arrayOf<T>(
  item: Validator<T>,
  options: ArrayOptions = {},
): Validator<readonly T[]> {
  return make(
    "array",
    (input, path) => {
      if (!Array.isArray(input)) fail("expected array", path, "array", input);
      const items = input as unknown[];
      if (options.minItems !== undefined && items.length < options.minItems) {
        fail(`array has fewer than ${options.minItems} items`, path, "array(minItems)", items);
      }
      if (options.maxItems !== undefined && items.length > options.maxItems) {
        fail(`array has more than ${options.maxItems} items`, path, "array(maxItems)", items);
      }
      return items.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
    () => {
      const schema: JsonSchema = { type: "array", items: item.toJsonSchema() };
      if (options.minItems !== undefined) schema["minItems"] = options.minItems;
      if (options.maxItems !== undefined) schema["maxItems"] = options.maxItems;
      if (options.description !== undefined) schema["description"] = options.description;
      return schema;
    },
  );
}

/** String-keyed map: `{ [key: string]: T }`. */
export function recordOf<T>(value: Validator<T>): Validator<Record<string, T>> {
  return make(
    "record",
    (input, path) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        fail("expected object", path, "object", input);
      }
      const source = input as Record<string, unknown>;
      const out: Record<string, T> = {};
      for (const key of Object.keys(source)) {
        out[key] = value.parse(source[key], `${path}.${key}`);
      }
      return out;
    },
    () => ({ type: "object", additionalProperties: value.toJsonSchema() }),
  );
}

export interface ObjectOptions {
  /**
   * `reject` (default) catches typos in user-supplied and compiled objects.
   * `allow` is used when reading persisted data so that a newer runtime's extra
   * fields survive a read by an older runtime (PRD NFR-COMP-02).
   */
  readonly unknownKeys?: "reject" | "allow";
  readonly description?: string;
}

export function objectOf<const S extends Shape>(
  shape: S,
  options: ObjectOptions = {},
): Validator<InferShape<S>> {
  const entries = Object.entries(shape) as Array<[string, Validator<unknown> | OptionalMarker<unknown>]>;
  const rejectUnknown = (options.unknownKeys ?? "reject") === "reject";

  return make(
    "object",
    (input, path) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        fail("expected object", path, "object", input);
      }
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};

      if (rejectUnknown) {
        for (const key of Object.keys(source)) {
          if (!Object.prototype.hasOwnProperty.call(shape, key)) {
            fail(`unexpected property "${key}"`, path, "known property", key);
          }
        }
      }

      for (const [key, spec] of entries) {
        const childPath = `${path}.${key}`;
        const hasValue = source[key] !== undefined;

        if (isOptionalSpec(spec)) {
          if (hasValue) out[key] = spec.inner.parse(source[key], childPath);
          continue;
        }
        if (!hasValue) fail(`missing required property "${key}"`, childPath, "required", undefined);
        out[key] = spec.parse(source[key], childPath);
      }

      if (!rejectUnknown) {
        for (const key of Object.keys(source)) {
          if (!Object.prototype.hasOwnProperty.call(out, key) && source[key] !== undefined) {
            out[key] = source[key];
          }
        }
      }

      return out as InferShape<S>;
    },
    () => {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, spec] of entries) {
        if (isOptionalSpec(spec)) {
          properties[key] = spec.inner.toJsonSchema();
        } else {
          properties[key] = spec.toJsonSchema();
          required.push(key);
        }
      }
      const schema: JsonSchema = { type: "object", properties };
      if (required.length > 0) schema["required"] = required;
      schema["additionalProperties"] = !rejectUnknown;
      if (options.description !== undefined) schema["description"] = options.description;
      return schema;
    },
  );
}

export function optional<T>(inner: Validator<T>): OptionalMarker<T> {
  return { __optional: true, inner };
}

export function isOptionalSpec(
  spec: Validator<unknown> | OptionalMarker<unknown>,
): spec is OptionalMarker<unknown> {
  return (spec as OptionalMarker<unknown>).__optional === true;
}

export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return anyOf(inner, lit(null)) as Validator<T | null>;
}

export function anyOf<const V extends readonly Validator<unknown>[]>(
  ...variants: V
): Validator<Infer<V[number]>> {
  if (variants.length === 0) throw new Error("anyOf requires at least one variant");
  return make(
    "union",
    (input, path) => {
      const errors: string[] = [];
      for (const variant of variants) {
        try {
          return variant.parse(input, path) as Infer<V[number]>;
        } catch (error) {
          errors.push(error instanceof SchemaValidationError ? error.expected : String(error));
        }
      }
      fail(`did not match any variant (${errors.join(" | ")})`, path, "union", input);
    },
    () => ({ anyOf: variants.map((variant) => variant.toJsonSchema()) }),
  );
}

/** Any JSON-representable value. Used for opaque payloads we do not interpret. */
export function jsonValue(): Validator<JsonValue> {
  return make(
    "json",
    (input, path) => {
      try {
        canonicalJson(input, path);
      } catch {
        fail("value is not JSON-representable", path, "json", input);
      }
      return input as JsonValue;
    },
    () => ({}),
  );
}

/** A JSON object with unknown contents (tool parameters, model metadata). */
export function looseObject(): Validator<Record<string, unknown>> {
  return make(
    "looseObject",
    (input, path) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        fail("expected object", path, "object", input);
      }
      return input as Record<string, unknown>;
    },
    () => ({ type: "object" }),
  );
}

/**
 * A versioned, named schema. The `id`/`version` pair is what appears in
 * exported contracts and in capability negotiation (PRD NFR-COMP-01,
 * NFR-COMP-03).
 */
export interface Schema<T> {
  readonly id: string;
  readonly version: string;
  readonly validator: Validator<T>;
  parse(input: unknown, path?: string): T;
  toJsonSchema(): JsonSchema;
}

export function defineSchema<T>(
  id: string,
  version: string,
  validator: Validator<T>,
): Schema<T> {
  const schema: Schema<T> = {
    id,
    version,
    validator,
    parse(input: unknown, path?: string): T {
      return validator.parse(input, path);
    },
    toJsonSchema(): JsonSchema {
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `${id}@${version}`,
        ...validator.toJsonSchema(),
      };
    },
  };
  // Schemas register themselves so `listSchemas()` is a complete, authoritative
  // inventory for protocol export and capability negotiation, with no separate
  // list that can fall out of date (PRD NFR-COMP-01, NFR-COMP-05).
  registerSchema(schema);
  return schema;
}

/**
 * The TypeScript type of a schema is derived from the validator, never declared
 * twice. If the two ever disagree, the validator wins at runtime — so deriving
 * is the only way to keep them honest.
 */
export type InferSchema<S> = S extends Schema<infer T> ? T : never;
export type InferValidator<V> = V extends Validator<infer T> ? T : never;

const registry = new Map<string, Schema<unknown>>();

export function registerSchema<T>(schema: Schema<T>): Schema<T> {
  const existing = registry.get(schema.id);
  if (existing !== undefined && existing.version !== schema.version) {
    throw new Error(
      `schema "${schema.id}" already registered at version ${existing.version}; ` +
        "bump the id or add an explicit migration instead of overwriting",
    );
  }
  registry.set(schema.id, schema as Schema<unknown>);
  return schema;
}

export function listSchemas(): ReadonlyArray<Schema<unknown>> {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getSchema(id: string): Schema<unknown> | undefined {
  return registry.get(id);
}
