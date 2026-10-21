/**
 * The append-only ledger.
 *
 * One JSONL file per task branch. Reading verifies the whole hash chain, because
 * a ledger that cannot be verified cannot be used to justify completion: if the
 * chain is broken the task must be reported as unrecoverable rather than
 * silently re-derived from untrusted rows (PRD 10, NFR-REL-05).
 */

import type { RunEvent, Sha256Hex } from "@keystone/schemas";
import { canonicalJson, sha256Hex } from "@keystone/schemas";

import { appendLineDurable, readJsonLines, withLock } from "../storage/atomic.ts";
import { verifyStoredEvent, type ChainPosition } from "./events.ts";

export interface LedgerIntegrity {
  readonly ok: boolean;
  /** Sequence number of the first event that failed verification. */
  readonly brokenAt?: number;
  readonly reason?: string;
}

export interface LedgerRead {
  readonly events: readonly RunEvent[];
  /** True when the file ended mid-record; the partial record was dropped. */
  readonly tornTail: boolean;
  readonly integrity: LedgerIntegrity;
  /** Digest of the whole file as read — used to detect changes between reads. */
  readonly fileHash: Sha256Hex;
}

const GENESIS: ChainPosition = { seq: 1, prevHash: null };

/** Position the next event should take, given the events already present. */
export function chainTip(events: readonly RunEvent[]): ChainPosition {
  if (events.length === 0) return GENESIS;
  const last = events[events.length - 1];
  if (last === undefined) return GENESIS;
  return { seq: last.seq + 1, prevHash: last.hash };
}

export async function appendEvent(filePath: string, event: RunEvent): Promise<void> {
  await withLock(`${filePath}.append.lock`, {}, async () => {
    const persisted = await readLedger(filePath);
    if (!persisted.integrity.ok) throw new LedgerIntegrityError(filePath, persisted.integrity);
    if (persisted.tornTail) throw new Error("ledger has a torn tail; recovery is required before append");
    const expected = chainTip(persisted.events);
    if (event.seq !== expected.seq || event.prevHash !== expected.prevHash) {
      throw new Error("ledger tip differs from the proposed event; refusing stale sequence");
    }
    const verified = verifyStoredEvent(event, expected.prevHash);
    if (!verified.ok) throw new Error(`event cannot be appended: ${verified.reason}`);
    await appendLineDurable(filePath, canonicalJson(event));
  });
}

export function verifyChain(events: readonly RunEvent[]): LedgerIntegrity {
  let prevHash: Sha256Hex | null = null;
  let expectedSeq = 1;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      return {
        ok: false,
        brokenAt: event.seq,
        reason: `expected seq ${expectedSeq} but found ${event.seq}`,
      };
    }
    const result = verifyStoredEvent(event, prevHash);
    if (!result.ok) {
      return { ok: false, brokenAt: event.seq, reason: result.reason };
    }
    prevHash = event.hash;
    expectedSeq += 1;
  }
  return { ok: true };
}

export async function readLedger(filePath: string): Promise<LedgerRead> {
  const { items, tornTail } = await readJsonLines<RunEvent>(filePath);
  const integrity = verifyChain(items);
  return {
    events: items,
    tornTail,
    integrity,
    fileHash: sha256Hex(canonicalJson(items)),
  };
}

/** Read a ledger that must be intact, or explain why it cannot be trusted. */
export async function readVerifiedLedger(filePath: string): Promise<LedgerRead> {
  const read = await readLedger(filePath);
  if (!read.integrity.ok) {
    throw new LedgerIntegrityError(filePath, read.integrity);
  }
  return read;
}

export class LedgerIntegrityError extends Error {
  readonly filePath: string;
  readonly integrity: LedgerIntegrity;
  constructor(filePath: string, integrity: LedgerIntegrity) {
    super(
      `ledger ${filePath} failed integrity verification at seq ${String(integrity.brokenAt)}: ${String(integrity.reason)}`,
    );
    this.name = "LedgerIntegrityError";
    this.filePath = filePath;
    this.integrity = integrity;
  }
}
