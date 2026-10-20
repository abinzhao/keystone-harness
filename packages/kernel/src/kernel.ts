/**
 * KernelSession — the only way authoritative state changes.
 *
 * Every mutation here follows the same shape: validate against the current state
 * and the contract, append events to the ledger, then fold. There is no other
 * write path, and no method changes a status without a transition declared in
 * the protocol table (ADR-0002).
 *
 * It deliberately knows nothing about models, tools or verifiers: those produce
 * observations and outcomes, and the runtime hands them here to be recorded.
 * Keeping the kernel ignorant of *how* work happens is what lets a task's proof
 * be checked without trusting the thing that produced it.
 */

import {
  actionRejectedPayloadSchema,
  canonicalJson,
  checkpointSchema,
  newId,
  nowIso,
  type ActionProposal,
  type BranchId,
  type Budget,
  type CapabilityLease,
  type Checkpoint,
  type CheckpointReason,
  type CompletionDecision,
  type ContextPlan,
  type EventActorKind,
  type EventType,
  type ExecutionStage,
  type EvidenceRecord,
  type InterventionRequest,
  type OutcomeContract,
  type ProjectFact,
  type ProjectId,
  type ProjectProfile,
  type ProofGraph,
  type ProofPackage,
  type RunBranch,
  type RunEvent,
  type Sha256Hex,
  type TaskId,
  type TaskState,
  type TaskStatus,
  type UserDecision,
} from "@keystone/schemas";

import type {
  ContractProposal,
  ContractProposer,
} from "./contract/propose.ts";
import { reviseContract, type ContractPatch, type ReviseContractResult } from "./contract/revise.ts";
import { invalidateForWorkspaceChange } from "./evidence/invalidate.ts";
import { listEvidence, recordEvidence, updateEvidence, type RecordEvidenceInput } from "./evidence/store.ts";
import { buildEvent } from "./ledger/events.ts";
import { foldTaskState } from "./ledger/fold.ts";
import { appendEvent, chainTip, readLedger, type LedgerRead } from "./ledger/ledger.ts";
import { assertTransition } from "./ledger/transitions.ts";
import { issueLease, type LeaseDenial, type LeaseIssueResult } from "./lease/lease.ts";
import type { ActionCapabilityResolver } from "./lease/resolve.ts";
import { buildProofGraph } from "./proof/graph.ts";
import { renderProofPackage, type RenderProofPackageInput } from "./proof/package.ts";
import { createBranch } from "./run/branches.ts";
import { createCheckpoint, latestCheckpoint } from "./run/checkpoints.ts";
import { assessRecovery, type RecoveryAssessment } from "./run/recovery.ts";
import { decidePath } from "./scope/scope.ts";
import { withLock, writeFileAtomic } from "./storage/atomic.ts";
import type { KeystonePaths } from "./storage/paths.ts";

export class KernelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}

export interface TaskReference {
  readonly kind: "file" | "directory" | "issue" | "log" | "url" | "text";
  readonly value: string;
}

export interface CreateTaskOptions {
  readonly paths: KeystonePaths;
  readonly projectId: ProjectId;
  readonly request: string;
  readonly references?: readonly TaskReference[];
  readonly requestedBy?: "user" | "cli" | "ci";
  readonly actorId?: string;
  /**
   * The scenario pack that drafts the Outcome Contract (ADR-0006). The runtime
   * wires the engineering proposer; the kernel never supplies one itself, so a
   * task without it cannot be compiled. Resumed/opened sessions do not need it
   * because compilation only happens while the task is still `defining`.
   */
  readonly proposeContract?: ContractProposer;
  /**
   * The scenario policy that resolves a proposed action to a Capability and its
   * resource values (ADR-0006, M1). The runtime wires the engineering resolver;
   * the kernel hard-codes no intent→capability or tool→resource mapping.
   * Authorising an action without it fails loudly. Resumed sessions that only
   * read/replay never consult it.
   */
  readonly resolveAction?: ActionCapabilityResolver;
}

export interface OpenTaskOptions {
  readonly paths: KeystonePaths;
  readonly taskId: TaskId;
  /** Open a specific run branch. Defaults to the task's primary branch. */
  readonly branchId?: BranchId;
  readonly actorId?: string;
  /**
   * Re-wire the action resolver when a reopened session continues to authorise
   * new work. Pure read/replay/proof paths never need it; it is optional so
   * resumed sessions that only fold the ledger are unaffected (M1).
   */
  readonly resolveAction?: ActionCapabilityResolver;
}

export interface TaskSummary {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly branchId: BranchId;
  readonly status: TaskStatus;
  readonly stage: ExecutionStage;
  readonly seq: number;
  readonly contractId?: string;
  readonly contractVersion?: number;
  readonly pendingInterventions: number;
  readonly outstandingEvidence: number;
  readonly updatedAt: string;
  readonly headline: string;
}

export interface EvaluationResult {
  readonly graph: ProofGraph;
  readonly decision: CompletionDecision;
}

interface SessionInit {
  readonly paths: KeystonePaths;
  readonly taskId: TaskId;
  readonly branchId: BranchId;
  readonly ledgerFile: string;
  readonly actorId: string;
  readonly events: readonly RunEvent[];
  readonly proposeContract?: ContractProposer;
  readonly resolveAction?: ActionCapabilityResolver;
}

export class KernelSession {
  private readonly paths: KeystonePaths;
  private readonly taskIdValue: TaskId;
  private readonly branchIdValue: BranchId;
  private readonly ledgerFile: string;
  private readonly actorId: string;
  private readonly proposeContract?: ContractProposer;
  private readonly resolveAction?: ActionCapabilityResolver;
  private eventLog: RunEvent[];
  private folded: TaskState;

  private constructor(init: SessionInit) {
    this.paths = init.paths;
    this.taskIdValue = init.taskId;
    this.branchIdValue = init.branchId;
    this.ledgerFile = init.ledgerFile;
    this.actorId = init.actorId;
    this.proposeContract = init.proposeContract;
    this.resolveAction = init.resolveAction;
    this.eventLog = [...init.events];
    // A brand-new task has no events yet, so there is nothing to fold. Every
    // reader of `folded` is reached only after `create()` has appended
    // `task.created`, which replaces this placeholder with the real fold.
    this.folded =
      this.eventLog.length > 0
        ? foldTaskState(this.eventLog)
        : pendingState(init.taskId, init.branchId);
  }

  static async create(options: CreateTaskOptions): Promise<KernelSession> {
    const taskId = newId("task") as TaskId;
    const branchId = newId("branch") as BranchId;
    const session = new KernelSession({
      paths: options.paths,
      taskId,
      branchId,
      ledgerFile: options.paths.ledgerFile(taskId),
      actorId: options.actorId ?? "cli",
      events: [],
      ...(options.proposeContract === undefined ? {} : { proposeContract: options.proposeContract }),
      ...(options.resolveAction === undefined ? {} : { resolveAction: options.resolveAction }),
    });

    await session.append("task.created", {
      projectId: options.projectId,
      request: options.request,
      requestedBy: options.requestedBy ?? "cli",
      references: [...(options.references ?? [])],
    });
    return session;
  }

  static async open(options: OpenTaskOptions): Promise<KernelSession> {
    const mainLedger = options.paths.ledgerFile(options.taskId);
    const main = await readVerified(mainLedger);
    if (main.events.length === 0) {
      throw new KernelError("task_not_found", `no ledger exists for task ${options.taskId}`);
    }

    const primaryBranchId = main.events[0]?.branchId as BranchId;
    const requestedBranch = options.branchId;
    const useBranch = requestedBranch !== undefined && requestedBranch !== primaryBranchId;

    if (!useBranch) {
      return new KernelSession({
        paths: options.paths,
        taskId: options.taskId,
        branchId: primaryBranchId,
        ledgerFile: mainLedger,
        actorId: options.actorId ?? "cli",
        events: main.events,
        ...(options.resolveAction === undefined ? {} : { resolveAction: options.resolveAction }),
      });
    }

    const branchLedger = options.paths.branchLedgerFile(options.taskId, requestedBranch);
    const read = await readVerified(branchLedger);
    if (read.events.length === 0) {
      // A branch directory that exists but holds no events cannot be folded, and
      // appending to it would produce a chain that fails verification on the next
      // read. Better to say so than to hand out a session that corrupts history.
      throw new KernelError(
        "branch_not_seeded",
        `run branch ${requestedBranch} has an empty ledger; it was created without ` +
          "forking the parent history, so it cannot be verified or continued",
      );
    }
    return new KernelSession({
      paths: options.paths,
      taskId: options.taskId,
      branchId: requestedBranch,
      ledgerFile: branchLedger,
      actorId: options.actorId ?? "cli",
      events: read.events,
      ...(options.resolveAction === undefined ? {} : { resolveAction: options.resolveAction }),
    });
  }

  get taskId(): TaskId {
    return this.taskIdValue;
  }

  get branchId(): BranchId {
    return this.branchIdValue;
  }

  get projectId(): ProjectId {
    return this.folded.projectId;
  }

  state(): TaskState {
    return this.folded;
  }

  events(): readonly RunEvent[] {
    return this.eventLog;
  }

  summary(): TaskSummary {
    return {
      taskId: this.taskIdValue,
      projectId: this.folded.projectId,
      branchId: this.branchIdValue,
      status: this.folded.status,
      stage: this.folded.stage,
      seq: this.folded.seq,
      ...(this.folded.contractId === undefined ? {} : { contractId: this.folded.contractId }),
      ...(this.folded.contractVersion === undefined
        ? {}
        : { contractVersion: this.folded.contractVersion }),
      pendingInterventions: this.folded.pendingInterventions.length,
      outstandingEvidence: this.folded.outstandingEvidence.length,
      updatedAt: this.folded.updatedAt,
      headline: describeTaskState(this.folded),
    };
  }

  contract(): OutcomeContract | undefined {
    const event = [...this.eventLog]
      .reverse()
      .find(
        (candidate) => candidate.type === "contract.compiled" || candidate.type === "contract.revised",
      );
    if (event === undefined) return undefined;
    const payload = event.payload;
    const value = event.type === "contract.compiled" ? payload : payload["contract"];
    return value === undefined ? undefined : (value as OutcomeContract);
  }

  // ---------------------------------------------------------------- lifecycle

  async submit(): Promise<TaskState> {
    this.requireStatus(["draft"], "submit the task");
    await this.append("task.submitted", {});
    await this.transition("task.submitted", "defining");
    return this.folded;
  }

  async compile(options: {
    readonly profile: ProjectProfile;
    readonly facts?: readonly ProjectFact[];
    readonly budget?: Budget;
    readonly autonomy: OutcomeContract["autonomy"];
  }): Promise<ContractProposal> {
    this.requireStatus(["defining"], "compile the Outcome Contract");
    const proposer = this.proposeContract;
    if (proposer === undefined) {
      // The kernel never drafts engineering content itself. A session compiled
      // without a wired scenario pack fails loudly rather than guessing (I8).
      throw new KernelError(
        "no_contract_proposer",
        "no scenario pack is wired to propose an Outcome Contract for this task",
      );
    }
    const result = proposer({
      taskId: this.taskIdValue,
      projectId: this.folded.projectId,
      request: this.request(),
      references: this.references(),
      profile: options.profile,
      facts: options.facts ?? [],
      autonomy: options.autonomy,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });

    await this.append("contract.compiled", asPayload(result.contract));
    await this.transition("contract.compiled", result.contract.status);
    return result;
  }

  async start(): Promise<void> {
    this.requireStatus(["ready", "awaiting_approval"], "start the task");
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError("no_contract", "cannot start a task without an Outcome Contract");
    }
    await this.append("task.started", {
      contractId: contract.contractId,
      contractVersion: contract.version,
      authorization: "policy_default",
    });
    await this.transition("task.started", "executing");
  }

  async pause(reason: string, byUser = true): Promise<void> {
    this.requireStatus(["executing", "verifying", "auto_repairing"], "pause the task");
    await this.append("task.paused", { reason, byUser });
    await this.transition("task.paused", "paused");
  }

  async stop(reason: string, byUser = true, outstanding: readonly string[] = []): Promise<void> {
    if (isTerminal(this.folded.status)) {
      throw new KernelError("invalid_state", `the task is already ${this.folded.status}`);
    }
    await this.append("task.stopped", { reason, byUser, outstanding: [...outstanding] });
    await this.transition("task.stopped", "stopped");
  }

  /** Record the intent to resume and return the checkpoint to verify against. */
  async requestResume(): Promise<Checkpoint> {
    const checkpoint = await latestCheckpoint(this.paths, this.taskIdValue, {
      branchId: this.branchIdValue,
    });
    if (checkpoint === undefined) {
      throw new KernelError(
        "no_checkpoint",
        "this task has no checkpoint, so there is nothing to resume from",
      );
    }
    await this.append("task.resume_requested", { checkpointId: checkpoint.checkpointId, byUser: true });
    await this.transition("task.resume_requested", "resuming");
    return checkpoint;
  }

  /**
   * Finish recovery. The assessment decides whether the task returns to its
   * previous status or stops and asks — never "assume it is still fine"
   * (PRD 10, NFR-REL-02).
   */
  async completeRecovery(assessment: RecoveryAssessment): Promise<void> {
    this.requireStatus(["resuming"], "complete recovery");
    await this.append("recovery.verified", {
      checkpointId: this.folded.activeCheckpointId ?? newId("ckpt"),
      workspaceMatchesCheckpoint: assessment.consistent,
      changedPaths: [...assessment.changedPaths],
      invalidated: [
        ...assessment.invalidatedEvidenceIds.map((id) => `evidence:${id}`),
        ...assessment.invalidatedFactIds.map((id) => `fact:${id}`),
      ],
      ...(assessment.resumedStatus === undefined ? {} : { resumedStatus: assessment.resumedStatus }),
    });
    await this.transition("recovery.verified", assessment.resumedStatus ?? "needs_attention");
  }

  async requestIntervention(request: InterventionRequest): Promise<void> {
    await this.append("intervention.requested", asPayload(request));
    await this.transition("attention.required", "needs_attention");
  }

  async decide(request: InterventionRequest, decision: UserDecision): Promise<void> {
    await this.append("intervention.decided", asPayload(decision));
    if (this.folded.status !== "needs_attention") return;
    // An expired request leaves the task waiting: there is no decision to act on,
    // so returning it to work would be inventing one.
    if (decision.decision === "expire") return;
    await this.transition("intervention.decided", "executing");
  }

  /**
   * Start a bounded repair attempt after a failed verification.
   *
   * The retry is consumed *here*, before the next attempt, so the budget reflects
   * reality and the "no viable path remains" decision is made from a real number
   * rather than an optimistic one (PRD VF-03).
   */
  async beginRepair(input: {
    readonly attempt: number;
    readonly rootCause: string;
    readonly changedPaths: readonly string[];
    readonly madeProgress: boolean;
  }): Promise<void> {
    this.requireStatus(["auto_repairing"], "begin a repair attempt");
    await this.append("budget.consumed", {
      delta: { tokens: 0, retries: 1, wallClockMs: 0, costUsd: 0 },
      reason: `repair attempt ${input.attempt}`,
      measured: true,
    });
    await this.append("repair.produced_change", {
      attempt: input.attempt,
      rootCause: input.rootCause,
      changedPaths: [...input.changedPaths],
      madeProgress: input.madeProgress,
    });
    await this.transition("repair.produced_change", "executing");
  }

  // ---------------------------------------------------------------- learning

  /**
   * Record experience lifecycle events.
   *
   * The firewall's own store is the authority for project-scoped experience, but
   * promotion must still be traceable to a kernel event (PRD 7.2, 9.2): a
   * long-term change to what future tasks are told has to be explainable, not
   * just persisted.
   */
  async recordExperienceCandidate(
    candidate: import("@keystone/schemas").ExperienceCandidate,
  ): Promise<void> {
    await this.append("experience.candidate_created", asPayload(candidate));
  }

  async recordExperiencePromotion(
    entry: import("@keystone/schemas").ExperienceEntry,
  ): Promise<void> {
    await this.append("experience.promoted", asPayload(entry));
  }

  async recordExperienceDemotion(input: {
    readonly entryId: string;
    readonly reason: string;
    readonly detail: string;
    readonly affectedTaskIds: readonly string[];
  }): Promise<void> {
    await this.append("experience.demoted", {
      entryId: input.entryId,
      reason: input.reason,
      detail: input.detail,
      affectedTaskIds: [...input.affectedTaskIds],
    });
  }

  async recordExperienceEvaluation(
    evaluation: import("@keystone/schemas").ExperienceEvaluation,
  ): Promise<void> {
    await this.append("experience.evaluated", asPayload(evaluation));
  }

  /**
   * Record an honest degradation.
   *
   * A weaker mode must be announced with what was lost and what that does to the
   * evidence, because silently continuing in a weaker mode and then claiming the
   * same level of proof is the most damaging thing a harness can do (EX-05, 9.1).
   */
  async applyDegradation(input: {
    readonly mode: "minimal" | "standard" | "isolated" | "replay";
    readonly reason: string;
    readonly capabilitiesLost: readonly string[];
    readonly evidenceImpact: string;
  }): Promise<void> {
    await this.append("degradation.applied", {
      mode: input.mode,
      reason: input.reason,
      capabilitiesLost: [...input.capabilitiesLost],
      evidenceImpact: input.evidenceImpact,
    });
  }

  /**
   * End the run without a proven verdict, keeping what was achieved.
   *
   * A returned run must never be left in an *active* status: "executing" means
   * work is still happening, and nothing is. The only honest endings for an
   * unfinished task are graceful exit (with the unsatisfied conditions named) or
   * needs-attention (PRD 9.1, 7.2).
   */
  async exitGracefully(input: {
    readonly exitId: string;
    readonly description: string;
    readonly unsatisfiedConditionIds: readonly string[];
  }): Promise<void> {
    await this.append("exit.conditions_met", {
      exitId: input.exitId,
      description: input.description,
      unsatisfiedConditionIds: [...input.unsatisfiedConditionIds],
    });
    await this.transition("exit.conditions_met", "exited_gracefully");
  }

  async revise(patch: ContractPatch, reason: string): Promise<ReviseContractResult> {
    const previous = this.contract();
    if (previous === undefined) {
      throw new KernelError("no_contract", "there is no contract to revise");
    }
    const result = reviseContract(previous, patch, reason, "user");
    await this.append("contract.revised", {
      contract: result.contract,
      previousContractId: previous.contractId,
      previousVersion: previous.version,
      changedFields: [...result.changedFields],
      invalidated: [...result.invalidated],
    });

    if (!isTerminal(this.folded.status) && this.folded.status !== "defining") {
      const target: TaskStatus =
        result.contract.status === "awaiting_approval" ? "awaiting_approval" : "executing";
      if (this.folded.status !== target) {
        await this.transition("contract.revised", target);
      }
    }
    return result;
  }

  // -------------------------------------------------------------- execution

  async recordContextPlan(plan: ContextPlan): Promise<void> {
    await this.append("context.plan_created", asPayload(plan));
  }

  /**
   * Authorise a proposed action. Scope and envelope are both checked; a lease is
   * issued or the refusal is recorded. A user decision never bypasses these
   * checks — confirming an action widens the boundary first (see lease.ts).
   */
  async authorize(
    proposal: ActionProposal,
    options: {
      readonly decision?: UserDecision;
      readonly derivedFromUntrusted?: boolean;
      readonly maxCalls?: number;
    } = {},
  ): Promise<LeaseIssueResult> {
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError("no_contract", "cannot authorise an action without a contract");
    }

    const resolver = this.resolveAction;
    if (resolver === undefined) {
      // The kernel never hard-codes the intent→capability / tool→resource mapping
      // (ADR-0006, M1). Authorising without a wired scenario policy fails loudly
      // rather than guessing what an action may do.
      throw new KernelError(
        "no_action_resolver",
        "no scenario pack is wired to resolve action capabilities for this task",
      );
    }

    const resolution = resolver(proposal);
    const capability = resolution.capability;
    if (capability === undefined) {
      const denial: LeaseDenial = {
        code: "resource_not_in_lease",
        detail:
          `intent "${proposal.intent}" is not a leasable capability; ` +
          "only the wired scenario policy decides what a task may do",
      };
      await this.recordRefusal(proposal, denial);
      return { ok: false, denial };
    }

    const result = issueLease({
      taskId: this.taskIdValue,
      branchId: this.branchIdValue,
      subject: { kind: "builder_loop", id: proposal.modelRef.id },
      capability,
      resourceValues: resolution.resourceValues,
      contract,
      envelope: contract.autonomy,
      ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
      ...(options.decision === undefined ? {} : { decision: options.decision }),
      ...(options.derivedFromUntrusted === undefined
        ? {}
        : { derivedFromUntrusted: options.derivedFromUntrusted }),
      reversibility: proposal.reversibility,
    });

    if (result.ok) {
      await this.append("lease.issued", asPayload(result.lease));
      await this.append("action.authorized", {
        proposalId: proposal.proposalId,
        leaseId: result.lease.leaseId,
      });
    } else {
      await this.recordRefusal(proposal, result.denial);
    }
    return result;
  }

  async recordExecution(input: {
    readonly proposalId: string;
    readonly leaseId?: string;
    readonly status: "succeeded" | "failed" | "timeout" | "cancelled";
    readonly exitCode?: number;
    readonly durationMs: number;
    readonly artifactId?: string;
    readonly outputHash?: string;
    readonly outputBytes?: number;
    readonly changedPaths?: readonly string[];
    readonly errorCode?: string;
    readonly workspaceSnapshotId?: string;
  }): Promise<void> {
    const contract = this.contract();
    await this.append("action.executed", {
      proposalId: input.proposalId,
      ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      durationMs: input.durationMs,
      ...(input.artifactId === undefined ? {} : { outputArtifactId: input.artifactId }),
      ...(input.outputHash === undefined ? {} : { outputHash: input.outputHash }),
      ...(input.outputBytes === undefined ? {} : { outputBytes: input.outputBytes }),
      changedPaths: [...(input.changedPaths ?? [])],
      ...(input.workspaceSnapshotId === undefined
        ? {}
        : { workspaceSnapshotId: input.workspaceSnapshotId }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    });

    // A scope violation discovered after the fact stops the run instead of being
    // folded into the next round of edits (PRD EX-03).
    if (contract === undefined) return;
    const violations = (input.changedPaths ?? []).filter(
      (path) => !decidePath(path, "write", contract.scope).allowed,
    );
    if (violations.length > 0) {
      await this.append("scope.violation_detected", {
        proposalId: input.proposalId,
        capability: "fs.write",
        attemptedPaths: violations,
        allowedPatterns: contract.scope.include.map((entry) => entry.pattern),
        effectApplied: true,
      });
      await this.transition("attention.required", "needs_attention");
    }
  }

  async recordEvidence(
    input: Omit<RecordEvidenceInput, "taskId" | "branchId" | "contractId" | "contractVersion"> & {
      readonly contractVersion?: number;
    },
  ): Promise<import("@keystone/schemas").EvidenceRecord> {
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError("no_contract", "cannot record evidence without a contract");
    }
    const record = await recordEvidence(this.paths, {
      ...input,
      taskId: this.taskIdValue,
      branchId: this.branchIdValue,
      contractId: contract.contractId,
      contractVersion: input.contractVersion ?? contract.version,
    });
    await this.append("evidence.recorded", asPayload(record));
    return record;
  }

  async evidence(): Promise<readonly import("@keystone/schemas").EvidenceRecord[]> {
    return listEvidence(this.paths, this.taskIdValue);
  }

  /**
   * Downgrade evidence that no longer describes the current workspace, *before*
   * the verdict is computed, so a stale pass cannot be counted (PRD VF-06).
   */
  async invalidateStaleEvidence(input: {
    readonly previousFingerprint?: string;
    readonly currentFingerprint: string;
    readonly changedPaths: readonly string[];
  }): Promise<readonly string[]> {
    const contract = this.contract();
    const all = await this.evidence();
    const { invalidated } = invalidateForWorkspaceChange(all, {
      ...(input.previousFingerprint === undefined
        ? {}
        : { previousFingerprint: input.previousFingerprint as never }),
      currentFingerprint: input.currentFingerprint as never,
      changedPaths: [...input.changedPaths],
      ...(contract === undefined ? {} : { currentContractVersion: contract.version }),
    });
    if (invalidated.length === 0) return [];
    // The downgrade must be durable before it is reported: a proof computed after
    // this call has to see the invalidated records, otherwise a stale pass would
    // still count (PRD VF-06).
    for (const record of invalidated) {
      await updateEvidence(this.paths, this.taskIdValue, record);
    }
    await this.append("evidence.invalidated", {
      evidenceIds: invalidated.map((record) => record.evidenceId),
      reason: "the workspace changed since this evidence was produced",
      trigger: "workspace_changed",
      affectedProofHashes:
        this.folded.proofGraphHash === undefined ? [] : [this.folded.proofGraphHash],
    });
    return invalidated.map((record) => record.evidenceId);
  }

  async evaluateProof(input: {
    readonly changedPaths: readonly string[];
    readonly workspaceFingerprint?: string;
    readonly verifierFailures?: readonly { conditionId: string; detail: string }[];
  }): Promise<EvaluationResult> {
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError("no_contract", "cannot evaluate completion without a contract");
    }

    const evidence = await this.evidence();
    const graph = buildProofGraph({
      contract,
      branchId: this.branchIdValue,
      changedPaths: [...input.changedPaths],
      workspaceFingerprint: input.workspaceFingerprint ?? "",
      evidence,
      ...(input.verifierFailures === undefined
        ? {}
        : { verifierFailures: [...input.verifierFailures] }),
    });

    if (this.folded.status === "executing" || this.folded.status === "auto_repairing") {
      await this.transition("verification.started", "verifying");
    }

    if (graph.decision.outcome === "proven") {
      await this.append("proof.satisfied", {
        proofGraphHash: graph.contentHash,
        contractId: contract.contractId,
        contractVersion: contract.version,
        conditionCount: contract.completionConditions.length,
      });
      if (this.folded.status === "verifying") {
        await this.transition("proof.satisfied", "proven");
      }
      return { graph, decision: graph.decision };
    }

    const top = graph.decision.reasons[0];
    await this.append("proof.evaluated", {
      proofGraphHash: graph.contentHash,
      reason: top === undefined ? "completion conditions are not all satisfied" : top.detail,
      stillHistoricallyProven: true,
    });

    if (this.folded.status === "verifying") {
      const repairBudgetLeft =
        this.folded.budgetUsed.retries < contract.budget.maxRetries;
      if (repairBudgetLeft) {
        await this.transition("verification.failed", "auto_repairing");
      } else {
        await this.transition("verification.failed", "exited_gracefully");
      }
    }

    return { graph, decision: graph.decision };
  }

  async exportProof(options: {
    readonly changedPaths: readonly string[];
    readonly redaction?: "none" | "metadata_only";
    readonly diffArtifactId?: string;
    readonly environment?: RenderProofPackageInput["environment"];
    readonly branchRationale?: string;
  }): Promise<ProofPackage> {
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError("no_contract", "cannot export a proof without a contract");
    }
    const evidence = await this.evidence();
    // Rebuilding is safe and intentional: the completion decision is a
    // deterministic query, so re-deriving it cannot change the verdict.
    const graph = buildProofGraph({
      contract,
      branchId: this.branchIdValue,
      changedPaths: [...options.changedPaths],
      workspaceFingerprint: "",
      evidence,
    });

    return renderProofPackage({
      graph,
      contract,
      changedPaths: [...options.changedPaths],
      ...(options.diffArtifactId === undefined ? {} : { diffArtifactId: options.diffArtifactId }),
      evidence,
      leases: collectLeases(this.eventLog),
      interventions: collectInterventions(this.eventLog),
      branchRationale: options.branchRationale ?? `branch ${this.branchIdValue}`,
      redaction: options.redaction ?? "none",
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
  }

  // ------------------------------------------------------------- checkpoints

  async checkpoint(
    reason: CheckpointReason,
    extras: {
      readonly verification?: {
        readonly workspaceFingerprint?: Sha256Hex;
        readonly dependencyFingerprint?: Sha256Hex;
        readonly toolFingerprint?: Sha256Hex;
      };
      readonly workspaceSnapshotId?: string;
      readonly pendingStepIds?: readonly string[];
      readonly artifactRefs?: readonly string[];
      readonly contractDigest?: Sha256Hex;
    } = {},
  ): Promise<Checkpoint> {
    const created = await createCheckpoint(this.paths, this.taskIdValue, {
      state: this.folded,
      reason,
      seq: this.folded.seq,
      ...(extras.workspaceSnapshotId === undefined
        ? {}
        : { workspaceSnapshotId: extras.workspaceSnapshotId }),
      ...(extras.verification === undefined ? {} : { verification: extras.verification }),
      pendingStepIds: [...(extras.pendingStepIds ?? [])],
      evidenceIds: [...this.folded.outstandingEvidence],
      artifactRefs: [...(extras.artifactRefs ?? [])],
      activeLeaseIds: [...this.folded.activeLeaseIds],
      extensions: [],
      ...(this.folded.activeCheckpointId === undefined
        ? {}
        : { parentCheckpointId: this.folded.activeCheckpointId }),
      ...(extras.contractDigest === undefined
        ? {}
        : { contractDigest: extras.contractDigest as never }),
    });

    await this.append("checkpoint.created", asPayload(created));
    return created;
  }

  async latestCheckpoint(): Promise<Checkpoint | undefined> {
    return latestCheckpoint(this.paths, this.taskIdValue, { branchId: this.branchIdValue });
  }

  async recover(input: {
    readonly workspaceFingerprint: string;
    readonly currentHeadCommit?: string;
    readonly currentToolFingerprint?: string;
    readonly currentDependencyFingerprint?: string;
    readonly changedPaths?: readonly string[];
  }): Promise<RecoveryAssessment> {
    const checkpoint = await this.latestCheckpoint();
    if (checkpoint === undefined) {
      throw new KernelError("no_checkpoint", "there is no checkpoint to recover from");
    }
    const contract = this.contract();
    return assessRecovery({
      checkpoint,
      workspaceFingerprint: input.workspaceFingerprint,
      ...(input.currentHeadCommit === undefined
        ? {}
        : { currentHeadCommit: input.currentHeadCommit }),
      ...(input.currentToolFingerprint === undefined
        ? {}
        : { currentToolFingerprint: input.currentToolFingerprint }),
      ...(input.currentDependencyFingerprint === undefined
        ? {}
        : { currentDependencyFingerprint: input.currentDependencyFingerprint }),
      ...(input.changedPaths === undefined ? {} : { changedPaths: [...input.changedPaths] }),
      evidence: await this.evidence(),
      ...(contract === undefined
        ? {}
        : { contractId: contract.contractId, contractVersion: contract.version }),
    });
  }

  /** Fork a new run branch. The source branch is never overwritten. */
  async branch(label: string, reason: string): Promise<RunBranch> {
    const contract = this.contract();
    if (contract === undefined) {
      throw new KernelError(
        "no_contract",
        "a run branch must reference a contract; compile one before forking",
      );
    }
    const checkpoint = await this.latestCheckpoint();
    const branch = await createBranch(this.paths, {
      taskId: this.taskIdValue,
      label,
      reason,
      contractId: contract.contractId,
      contractVersion: contract.version,
      forkedFromBranchId: this.branchIdValue,
      ...(checkpoint === undefined ? {} : { parentCheckpointId: checkpoint.checkpointId }),
    });

    // The fork carries the parent's history so the branch is independently
    // verifiable and replayable. Without this the branch ledger would start at
    // seq 1 while linking to a parent hash, and every read would fail integrity
    // verification (ADR-0003).
    const seeded = this.eventLog.map((event) => canonicalJson(event)).join("\n");
    await writeFileAtomic(
      this.paths.branchLedgerFile(this.taskIdValue, branch.branchId),
      seeded === "" ? "" : `${seeded}\n`,
    );
    return branch;
  }

  /** Fold the ledger again and confirm the authoritative status is reproducible. */
  replay(): { readonly status: TaskStatus; readonly seq: number; readonly consistent: boolean } {
    const reevaluated = foldTaskState(this.eventLog);
    return {
      status: reevaluated.status,
      seq: reevaluated.seq,
      consistent:
        reevaluated.status === this.folded.status &&
        reevaluated.seq === this.folded.seq &&
        reevaluated.proofGraphHash === this.folded.proofGraphHash,
    };
  }

  // --------------------------------------------------------------- internals

  private request(): string {
    const created = this.eventLog.find((event) => event.type === "task.created");
    const request = created?.payload["request"];
    return typeof request === "string" ? request : "";
  }

  private references(): readonly TaskReference[] {
    const created = this.eventLog.find((event) => event.type === "task.created");
    const references = created?.payload["references"];
    return Array.isArray(references) ? (references as TaskReference[]) : [];
  }

  private requireStatus(oneOf: readonly TaskStatus[], action: string): void {
    if (!oneOf.includes(this.folded.status)) {
      throw new KernelError(
        "invalid_state",
        `cannot ${action} while the task is "${this.folded.status}"; ` +
          `this action is valid in: ${oneOf.join(", ")}`,
      );
    }
  }

  private async recordRefusal(proposal: ActionProposal, denial: LeaseDenial): Promise<void> {
    await this.append(
      "action.rejected",
      asPayload(
        actionRejectedPayloadSchema.parse({
          proposalId: proposal.proposalId,
          code: denialCodeForEvent(denial.code),
          detail: denial.detail,
          ...(denial.suggestedOption === undefined ? {} : { fallback: denial.suggestedOption }),
        }),
      ),
    );
  }

  private async append(
    type: EventType,
    payload: Record<string, unknown>,
    actor: { kind: EventActorKind; id: string } = { kind: "kernel", id: this.actorId },
  ): Promise<RunEvent> {
    return withLock(
      this.paths.taskLockFile(this.taskIdValue),
      { holder: `kernel:${this.actorId}`, timeoutMs: 10_000 },
      async () => {
        const event = buildEvent(
          {
            taskId: this.taskIdValue,
            branchId: this.branchIdValue,
            type,
            payload,
            actorKind: actor.kind,
            actorId: actor.id,
          },
          chainTip(this.eventLog),
        );
        await appendEvent(this.ledgerFile, event);
        this.eventLog = [...this.eventLog, event];
        this.folded = foldTaskState(this.eventLog);
        return event;
      },
    );
  }

  private async transition(cause: EventType, to: TaskStatus): Promise<void> {
    const from = this.folded.status;
    assertTransition(from, cause, to);
    await this.append("task.status_changed", { from, to, event: cause });
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Placeholder state for a task whose `task.created` event has not been written. */
function pendingState(taskId: TaskId, branchId: BranchId): TaskState {
  return {
    taskId,
    projectId: "proj_00000000000000000000000000",
    branchId,
    status: "draft",
    stage: "understanding",
    seq: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    budgetUsed: { tokens: 0, retries: 0, wallClockMs: 0, costUsd: 0 },
    pendingInterventions: [],
    outstandingEvidence: [],
    activeLeaseIds: [],
  } as unknown as TaskState;
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "proven" ||
    status === "exited_gracefully" ||
    status === "failed" ||
    status === "stopped"
  );
}

function describeTaskState(state: TaskState): string {
  const contract =
    state.contractVersion === undefined ? "no contract" : `contract v${state.contractVersion}`;
  const pending = state.pendingInterventions.length;
  const evidence = state.outstandingEvidence.length;
  return [
    state.status,
    contract,
    `stage ${state.stage}`,
    `${evidence} evidence record(s)`,
    pending === 0 ? "no pending decisions" : `${pending} pending decision(s)`,
  ].join(" · ");
}

function denialCodeForEvent(code: LeaseDenial["code"]): string {
  switch (code) {
    case "out_of_contract_scope":
      return "out_of_scope";
    case "capability_outside_envelope":
    case "credential_not_permitted":
    case "network_host_not_permitted":
    case "command_not_permitted":
    case "external_system_not_permitted":
      return "envelope_exceeded";
    case "irreversible_requires_confirmation":
      return "irreversible_requires_confirmation";
    case "untrusted_content_cannot_authorize":
      return "untrusted_content_cannot_authorize";
    default:
      return "policy_denied";
  }
}

function collectLeases(events: readonly RunEvent[]): readonly CapabilityLease[] {
  return events
    .filter((event) => event.type === "lease.issued")
    .map((event) => event.payload as unknown as CapabilityLease);
}

function collectInterventions(
  events: readonly RunEvent[],
): readonly { interventionId: string; trigger: string; decision: string; rationale: string }[] {
  const triggers = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "intervention.requested") continue;
    const id = event.payload["interventionId"];
    const trigger = event.payload["trigger"];
    if (typeof id === "string") {
      triggers.set(id, typeof trigger === "string" ? trigger : "unknown");
    }
  }

  const decided: { interventionId: string; trigger: string; decision: string; rationale: string }[] = [];
  for (const event of events) {
    if (event.type !== "intervention.decided") continue;
    const payload = event.payload;
    const interventionId =
      typeof payload["interventionId"] === "string" ? payload["interventionId"] : "";
    decided.push({
      interventionId,
      trigger: triggers.get(interventionId) ?? "unknown",
      decision: typeof payload["decision"] === "string" ? payload["decision"] : "unknown",
      rationale: typeof payload["rationale"] === "string" ? payload["rationale"] : "",
    });
  }
  return decided;
}

async function readVerified(filePath: string): Promise<LedgerRead> {
  const read = await readLedger(filePath);
  if (!read.integrity.ok) {
    throw new KernelError(
      "ledger_integrity",
      `the ledger failed integrity verification at seq ${String(read.integrity.brokenAt)}: ` +
        `${String(read.integrity.reason)}. Keystone will not continue from a ledger it cannot trust.`,
    );
  }
  return read;
}
