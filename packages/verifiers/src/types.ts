/**
 * Verifier contracts.
 *
 * A verifier reports *what it observed* and *how independent that observation
 * was*; it never writes an EvidenceRecord itself. Evidence is only ever
 * appended by the kernel, so a verifier cannot promote its own claim into proof
 * (PRD VF-01, VF-04). The descriptor therefore has to be honest about the
 * evidence level it can support and what it is independent *of*: an over-claim
 * here would let a same-process string check masquerade as independent
 * confirmation, which is precisely the failure VF-02 exists to prevent.
 */

import type { KeystonePaths } from "@keystone/kernel";
import type {
  CompletionCondition,
  EvidenceLevel,
  IndependenceTarget,
  OutcomeContract,
  VerifierKind,
} from "@keystone/schemas";

export interface VerifierIndependence {
  readonly mode: "same_process" | "separate_process" | "isolated_workspace" | "external_service";
  readonly independentOf: readonly IndependenceTarget[];
}

export interface VerifierDescriptor {
  readonly kind: VerifierKind;
  readonly id: string;
  readonly version: string;
  readonly evidenceLevel: EvidenceLevel;
  /** False for E0/E1: such a verifier may only serve conditions that are not required. */
  readonly canSatisfyRequiredCondition: boolean;
  readonly independence: VerifierIndependence;
  readonly timeoutMs: number;
  readonly requiresCommand: boolean;
  readonly description: string;
}

export interface VerifierContext {
  readonly rootPath: string;
  readonly taskId: string;
  readonly branchId: string;
  readonly paths: KeystonePaths;
  readonly contract: OutcomeContract;
  /** The conditions this run covers (already filtered to the affected ones). */
  readonly conditions: readonly CompletionCondition[];
  readonly changedPaths: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface VerifierOutcome {
  readonly status: "passed" | "failed" | "blocked" | "inconclusive";
  readonly summary: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputBytes: number;
  readonly artifactId?: string;
  readonly truncated: boolean;
  /** Checks that could not be evaluated. Must be surfaced, never swallowed. */
  readonly incomplete?: readonly string[];
  readonly durationMs: number;
  /** Per-condition verdict when one command covers several conditions. */
  readonly conditionResults?: Readonly<Record<string, boolean>>;
}

export interface Verifier {
  readonly descriptor: VerifierDescriptor;
  run(ctx: VerifierContext): Promise<VerifierOutcome>;
}

/**
 * Raised when a verifier cannot even start (for example a missing tool). The
 * distinction from a plain failure matters: "we could not check" and "the check
 * failed" must never be reported as the same thing (PRD 9.1).
 */
export class VerifierBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "VerifierBlockedError";
    this.reason = reason;
  }
}
