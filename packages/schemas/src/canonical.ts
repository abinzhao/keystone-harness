/**
 * Canonical JSON encoding and content addressing.
 *
 * Every hash Keystone computes (event hash chains, artifact addresses, evidence
 * content hashes, workspace file digests) must be reproducible across machines
 * and processes, otherwise replay and proof verification are meaningless
 * (PRD NFR-REL-05, VF-04). `JSON.stringify` cannot be used directly because key
 * order depends on insertion order.
 */

import { createHash } from "node:crypto";

import type { JsonValue, Sha256Hex } from "./primitives.ts";

export class CanonicalEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalEncodingError";
  }
}

/**
 * Deterministic JSON: object keys sorted by code unit, `undefined` members
 * dropped, no whitespace. Rejects values that cannot round-trip through JSON so
 * a canonical encoding failure surfaces at write time rather than as a silent
 * hash mismatch later.
 */
export function canonicalJson(value: unknown, path = "$"): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalEncodingError(`non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (type === "bigint") {
    throw new CanonicalEncodingError(`bigint is not JSON-representable at ${path}`);
  }
  if (type === "undefined") {
    throw new CanonicalEncodingError(`undefined is not JSON-representable at ${path}`);
  }
  if (type === "function" || type === "symbol") {
    throw new CanonicalEncodingError(`${type} is not JSON-representable at ${path}`);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      if (item === undefined) {
        throw new CanonicalEncodingError(
          `undefined array hole at ${path}[${i}]; use null for absent elements`,
        );
      }
      parts.push(canonicalJson(item, `${path}[${i}]`));
    }
    return `[${parts.join(",")}]`;
  }

  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(member, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  }

  throw new CanonicalEncodingError(`unsupported value at ${path}`);
}

export function sha256Hex(input: string): Sha256Hex {
  return createHash("sha256").update(input, "utf8").digest("hex") as Sha256Hex;
}

export function sha256Bytes(input: Uint8Array): Sha256Hex {
  return createHash("sha256").update(input).digest("hex") as Sha256Hex;
}

/** Content address of any JSON-representable value. */
export function contentHash(value: unknown): Sha256Hex {
  return sha256Hex(canonicalJson(value));
}

/**
 * Hash chain link for the append-only ledger (PRD 7.2). The previous hash is
 * part of the payload so that reordering, dropping or mutating any event breaks
 * every downstream link.
 */
export function chainHash(prevHash: Sha256Hex | null, canonicalPayload: string): Sha256Hex {
  return sha256Hex(`${prevHash ?? "genesis"}\u0000${canonicalPayload}`);
}

/** Structural deep equality over JSON values, using canonical form. */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
