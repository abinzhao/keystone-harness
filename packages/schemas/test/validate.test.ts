import assert from "node:assert/strict";
import test from "node:test";

import {
  anyOf,
  arrayOf,
  bool,
  canonicalJson,
  canonicalJson as cj,
  chainHash,
  contentHash,
  defineSchema,
  enumOf,
  int,
  isIsoTimestamp,
  listSchemas,
  lit,
  newId,
  nonEmptyStr,
  nullable,
  num,
  objectOf,
  optional,
  provenanceRefSchema,
  registerSchema,
  relativePathValidator,
  SchemaValidationError,
  sha256Hex,
  str,
  taskIdValidator,
  trustRank,
  effectiveTrust,
} from "../src/index.ts";

test("canonicalJson sorts keys and drops undefined", () => {
  assert.equal(cj({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(cj({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(cj([1, "x", null]), '[1,"x",null]');
  // Key order of the input must not change the output.
  assert.equal(cj({ x: { b: 1, a: 2 } }), cj({ x: { a: 2, b: 1 } }));
});

test("canonicalJson refuses values that cannot round-trip", () => {
  // Object members that are `undefined` are dropped, so callers can build
  // objects with optional fields without post-processing them.
  assert.equal(canonicalJson({ a: undefined }), "{}");
  assert.equal(canonicalJson({ a: 1, b: undefined, c: null }), '{"a":1,"c":null}');
  // An `undefined` array element is a hole rather than an absent member, so it
  // must be rejected instead of silently shifting positions.
  assert.throws(() => canonicalJson([1, undefined]), /undefined/);
  assert.throws(() => canonicalJson(undefined), /undefined/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
});

test("content hashing is stable and chain links change when payload changes", () => {
  const a = contentHash({ id: 1, name: "x" });
  const b = contentHash({ name: "x", id: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(chainHash(null, "p"), chainHash(sha256Hex("p"), "p"));
  assert.notEqual(chainHash(sha256Hex("a"), "p"), chainHash(sha256Hex("b"), "p"));
});

test("ids are prefixed ULIDs that sort by creation order", () => {
  const first = newId("task");
  const second = newId("task");
  assert.match(first, /^task_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(first < second, `${first} should sort before ${second}`);
  assert.ok(isIsoTimestamp(new Date().toISOString()));
  assert.ok(!isIsoTimestamp("2026-10-19 06:00:00"));
});

test("objectOf validates required and optional fields and reports the path", () => {
  const schema = objectOf({
    name: nonEmptyStr(),
    retries: optional(int({ min: 0 })),
    level: enumOf(["low", "high"] as const),
    tags: arrayOf(str()),
    ratio: num({ min: 0, max: 1 }),
    enabled: bool(),
    nothing: lit(null),
    maybe: nullable(str()),
  });

  const value = schema.parse({
    name: "a",
    level: "low",
    tags: ["x"],
    ratio: 0.5,
    enabled: true,
    nothing: null,
    maybe: null,
  });
  assert.equal(value.retries, undefined);

  assert.throws(
    () => schema.parse({ name: "", level: "low", tags: [], ratio: 0.5, enabled: true, nothing: null, maybe: null }),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.path, "$.name");
      return true;
    },
  );

  assert.throws(
    () => schema.parse({ name: "a", level: "low", tags: [], ratio: 2, enabled: true, nothing: null, maybe: null }),
    (error: unknown) => error instanceof SchemaValidationError && error.path === "$.ratio",
  );
});

test("objectOf rejects unknown keys by default and can allow them for stored data", () => {
  const strict = objectOf({ a: str() });
  assert.throws(() => strict.parse({ a: "x", typo: 1 }), /unexpected property "typo"/);

  const lenient = objectOf({ a: str() }, { unknownKeys: "allow" });
  const parsed = lenient.parse({ a: "x", fromFuture: 1 }) as Record<string, unknown>;
  assert.equal(parsed["fromFuture"], 1);
});

test("objectOf rejects arrays and null", () => {
  const schema = objectOf({ a: str() });
  assert.throws(() => schema.parse([]), /expected object/);
  assert.throws(() => schema.parse(null), /expected object/);
});

test("anyOf produces the union of variants and reports the path", () => {
  const schema = anyOf(str(), int());
  assert.equal(schema.parse("x"), "x");
  assert.equal(schema.parse(4), 4);
  assert.throws(() => schema.parse(true), (error: unknown) => {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.path, "$");
    return true;
  });
});

test("json schema is derived from the same combinators", () => {
  const schema = objectOf({
    name: nonEmptyStr(),
    retries: optional(int({ min: 0 })),
  });
  const json = schema.toJsonSchema() as {
    type: string;
    required: string[];
    properties: Record<string, { type: string; minLength?: number }>;
    additionalProperties: boolean;
  };
  assert.equal(json.type, "object");
  assert.deepEqual(json.required, ["name"]);
  assert.equal(json.properties["name"]?.["type"], "string");
  assert.equal(json.properties["retries"]?.["type"], "integer");
  assert.equal(json.additionalProperties, false);
});

test("branded validators reject malformed ids", () => {
  assert.match(taskIdValidator.parse(newId("task")), /^task_/);
  assert.throws(() => taskIdValidator.parse("task_short"), /does not match/);
  assert.throws(() => taskIdValidator.parse("evt_01J0000000000000000000000"), /does not match/);
});

test("relativePathValidator blocks absolute paths and parent escapes", () => {
  assert.equal(relativePathValidator.parse("src/auth/session.ts"), "src/auth/session.ts");
  assert.throws(() => relativePathValidator.parse("/etc/passwd"), /does not match/);
  assert.throws(() => relativePathValidator.parse("../secrets"), /does not match/);
  assert.throws(() => relativePathValidator.parse("src/../../x"), /does not match/);
  // Traversal via segment after a normal prefix is the case that matters most.
  assert.throws(() => relativePathValidator.parse("a/../../b"), /does not match/);
});

test("trust never increases along a derivation chain", () => {
  assert.equal(effectiveTrust("verified", ["untrusted"]), "untrusted");
  assert.equal(effectiveTrust("observed", ["verified"]), "observed");
  assert.equal(effectiveTrust("authoritative", ["user_confirmed"]), "user_confirmed");
  assert.equal(effectiveTrust("untrusted", ["authoritative"]), "untrusted");
  assert.equal(effectiveTrust("verified", []), "verified");
  assert.ok(trustRank("untrusted") < trustRank("authoritative"));
});

test("provenance schema round-trips a realistic record", () => {
  const record = {
    provenanceId: newId("prov"),
    sourceKind: "tool" as const,
    trustLevel: "verified" as const,
    locator: "pnpm test -> packages/kernel",
    derivedFrom: [],
    invalidatedBy: ["workspace.snapshot.changed"],
    observedAt: new Date().toISOString(),
  };
  const parsed = provenanceRefSchema.parse(record);
  assert.equal(parsed.sourceKind, "tool");
  assert.equal(parsed.applicableSnapshot, undefined);
  assert.throws(() => provenanceRefSchema.parse({ ...record, trustLevel: "totally-trusted" }));
});

test("schema registry refuses silent version overwrite and lists deterministically", () => {
  const first = defineSchema("test.sample", "1.0.0", objectOf({ a: str() }));
  registerSchema(first);
  assert.throws(
    () => registerSchema(defineSchema("test.sample", "2.0.0", objectOf({ a: str() }))),
    /already registered at version 1.0.0/,
  );
  // Re-registering the identical version is idempotent.
  registerSchema(defineSchema("test.sample", "1.0.0", objectOf({ a: str() })));
  const ids = listSchemas().map((schema) => schema.id);
  assert.deepEqual([...ids].sort(), ids);
});
