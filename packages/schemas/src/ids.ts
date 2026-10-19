/**
 * Identifier and timestamp generation.
 *
 * ULID (Crockford base32, 48-bit timestamp + 80-bit randomness) is used so that
 * identifiers sort lexicographically by creation time. That keeps `ls` output,
 * event ordering within the same millisecond, and artifact directories readable
 * without a database. Randomness comes from `node:crypto`, and the same
 * millisecond is made monotonic so two ids created in the same tick still sort
 * in creation order.
 */

import { createHash, randomBytes } from "node:crypto";

import type { IsoTimestamp } from "./primitives.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number, length: number): string {
  let out = "";
  let remaining = time;
  for (let i = length - 1; i >= 0; i -= 1) {
    const mod = remaining % 32;
    out = CROCKFORD[mod] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Crockford base32 encoding of raw bytes.
 *
 * Used to turn a digest into an identifier that satisfies the same character
 * class as a ULID body. That lets path-derived ids (project, artifact) be
 * deterministic and *also* validate as ordinary Keystone ids — an artifact id
 * simply *is* its content address, so `getArtifact(id)` needs no index.
 */
export function crockfordBase32(bytes: Uint8Array): string {
  return encodeRandom(bytes);
}

/**
 * Deterministic 26-character body derived from a string. Identical inputs yield
 * identical ids on every machine, which is what makes project ids and artifact
 * addresses reproducible across a team and across a replay.
 */
export function derivedIdBody(seed: string, length = 26): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const encoded = encodeRandom(new Uint8Array(digest));
  return encoded.slice(0, length);
}

/** Monotonic ULID. Two calls in the same millisecond are still ordered. */
export function newId(prefix?: string): string {
  const now = Date.now();
  let randomPart: string;

  if (now === lastTime) {
    // Increment the previous randomness by one to preserve ordering.
    let carry = 1;
    for (let i = lastRandom.length - 1; i >= 0 && carry === 1; i -= 1) {
      const current = lastRandom[i] ?? 0;
      const next = current + carry;
      lastRandom[i] = next & 255;
      carry = next > 255 ? 1 : 0;
    }
    if (carry === 1) {
      // Overflow within the same millisecond: borrow the next millisecond.
      lastTime += 1;
      lastRandom = Array.from(randomBytes(10));
    }
    randomPart = encodeRandom(Uint8Array.from(lastRandom));
  } else {
    lastTime = now;
    lastRandom = Array.from(randomBytes(10));
    randomPart = encodeRandom(Uint8Array.from(lastRandom));
  }

  const id = encodeTime(lastTime, 10) + randomPart;
  return prefix === undefined ? id : `${prefix}_${id}`;
}

export function nowIso(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

export function toIso(date: Date): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}

export function isIsoTimestamp(value: string): value is IsoTimestamp {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
