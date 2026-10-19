/**
 * Content-addressed artifact store.
 *
 * Tool output, diffs, rendered Context Capsules and snapshot entry lists are
 * stored by content hash, and the ledger keeps only the address. Two runs that
 * produce identical bytes share one file, and a reader can verify that the
 * bytes it fetched are exactly the bytes that were referenced (PRD 12.4,
 * DP-02).
 */

import { join } from "node:path";

import {
  canonicalJson,
  sha256Bytes,
  type ArtifactId,
  type Sha256Hex,
} from "@keystone/schemas";

import { ensureDir, readTextFile, writeFileAtomic } from "./atomic.ts";
import type { KeystonePaths } from "./paths.ts";

export interface StoredArtifact {
  readonly artifactId: ArtifactId;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

/** Two-level fan-out keeps directory listings small on large stores. */
export function artifactPath(paths: KeystonePaths, digest: Sha256Hex): string {
  return join(paths.artifactsDir, digest.slice(0, 2), digest);
}

export function artifactIdForDigest(digest: Sha256Hex): ArtifactId {
  return `art_${digest}` as ArtifactId;
}

export function digestFromArtifactId(artifactId: string): Sha256Hex {
  if (!artifactId.startsWith("art_")) {
    throw new Error(`not an artifact id: ${artifactId}`);
  }
  return artifactId.slice(4) as Sha256Hex;
}

export async function putArtifact(
  paths: KeystonePaths,
  data: string | Uint8Array,
): Promise<StoredArtifact> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = sha256Bytes(bytes);
  const filePath = artifactPath(paths, digest);
  // Re-writing identical content is harmless and keeps the store idempotent,
  // which matters because replays re-put the same artifacts.
  await ensureDir(join(paths.artifactsDir, digest.slice(0, 2)));
  await writeFileAtomic(filePath, bytes);
  return { artifactId: artifactIdForDigest(digest), sha256: digest, bytes: bytes.byteLength };
}

export async function putJsonArtifact(
  paths: KeystonePaths,
  value: unknown,
): Promise<StoredArtifact> {
  return putArtifact(paths, canonicalJson(value));
}

export async function getArtifactBytes(
  paths: KeystonePaths,
  artifactId: string,
): Promise<Uint8Array | undefined> {
  const digest = digestFromArtifactId(artifactId);
  const { readFile } = await import("node:fs/promises");
  try {
    return new Uint8Array(await readFile(artifactPath(paths, digest)));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function getArtifactText(
  paths: KeystonePaths,
  artifactId: string,
): Promise<string | undefined> {
  const digest = digestFromArtifactId(artifactId);
  return readTextFile(artifactPath(paths, digest));
}

export async function readJsonArtifact<T>(
  paths: KeystonePaths,
  artifactId: string,
): Promise<T | undefined> {
  const text = await getArtifactText(paths, artifactId);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export async function hasArtifact(
  paths: KeystonePaths,
  artifactId: string,
): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(artifactPath(paths, digestFromArtifactId(artifactId)));
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
