# Keystone Competitive Product Design (Historical Baseline Draft)

> ## ⚠️ Historical document, superseded by PRD v1.0
>
> This document is an **early competitive product design from before PRD v1.0** and is in version conflict with `需求文档.md` (PRD v1.0).
>
> - **Source of truth**: in case of conflict, [`需求文档.md`](../../../需求文档.md) (PRD v1.0) always prevails.
> - **Reason for retention**: this draft is retained as a **historical baseline** to trace the evolution of concepts; it does not represent a current product commitment.
> - **How to use**: do not implement or accept based on this document; any capability not reflected in the PRD **does not constitute a product commitment**.

**Document date**: 2026-10-19 (early draft)
**Status**: Superseded by PRD v1.0
**Nature**: Historical competitive product design baseline

---

## 1. Early Positioning

The early design centered on three outcomes:

- **High success rate**: reduce repeated communication and manual re-review, and get the task right the first time.
- **Long-term project understanding**: maintain an understanding of the project across tasks instead of re-learning the repository every session.
- **Verifiable results**: base "done" on checkable results rather than on the model's own account.

This is consistent with the six value directions of the later PRD v1.0 — "understands the project better / results are provable / uninterrupted over the long term / autonomy is controllable / steadier the more it is used / open and composable" — but the **wording and boundaries were rougher**, and the later partial-order governance framework had not yet taken shape at that time.

## 2. The Three Early Core Concepts

### 2.1 Living Project Model (Project Understanding Model)

A continuously evolving "living project model" that accumulates project structure, rules, test relationships, and historical experience over time for reuse by subsequent tasks.

**In the concept at the time**, the emphasis was on "continuous accumulation and reuse"; the characterization of **provenance, time, applicable snapshot, and precise invalidation** was still incomplete.

### 2.2 Proof-Carrying Changes (Changes with Proof)

Every change carries its proof with it, so that results can be checked and reproduced, not merely "look right".

**In the concept at the time**, the emphasis was the binding of "change + proof"; the modeling of **evidence level, independence, dependency graph, and deterministic completion determination** was still incomplete.

### 2.3 Experience Cache

Cache historical successful experience and reuse it in similar tasks to reduce cost and increase the success rate.

**In the concept at the time**, the emphasis was "caching and hits"; the governance of **candidate quarantine, promotion conditions, negative transfer, and forgetting** had not yet been introduced.

## 3. Task-Level Contract and Result-Guarantee Loop

The early design organized the loop of a single task around a "task-level contract", comprising four components:

| Component | Early meaning |
|---|---|
| Outcome Compiler (Outcome Contract) | Compile a natural-language task into structured goals, scope, and completion conditions |
| Context Capsules | Package the minimal context needed for the current step |
| Independent Verifiers | Check results with verifiers independent of the executor |
| Proof Package | A deliverable-oriented proof package stating what changed and why it is deliverable |

The intent of this loop: **one task = one contract + one set of context + independent verification + a deliverable proof**.

## 4. Evolution of the Concepts in PRD v1.0

The early concepts were not discarded but absorbed, tightened, and systematized in PRD v1.0:

| Early concept | Evolution in PRD v1.0 | Key change |
|---|---|---|
| Living Project Model | **Project World Model** (PRD 8.1) | Every fact carries a source, time, applicable snapshot, and invalidation conditions; it distinguishes when a fact holds, when the system observed it, and which snapshot it applies to; supports precise incremental invalidation and user correction |
| Proof-Carrying Changes | **Proof Graph / Proof Package** (PRD 8.5 VF-04, 8.6 DP-01) | Upgraded from "changes with proof" to an **evidence dependency graph + deterministic completion determination**: a completion condition is the result of a Proof Graph query against the current Contract and Workspace Snapshot, supporting evidence grading, independence, and precise invalidation |
| Experience Cache | **Experience Firewall** (PRD 8.7 LE-01~04) | Upgraded from "cache and reuse" to a firewall of **candidate quarantine → evaluation → promotion/demotion** that evaluates positive transfer, negative transfer, and forgetting |
| Outcome Compiler (Outcome Contract) | **Outcome Contract** (PRD 8.2 OT-01~04) | Fills in target outcome, change scope, invariants, completion conditions, evidence requirements, budget, autonomy boundary, uncertainties, intervention conditions, and exit conditions; supports versioning and machine-readable import/export |
| Context Capsules | **Context Capsule + Context Plan** (PRD 8.3 CX-01~04) | Upgraded from "packaging context" to an **explicable minimal context and its selection plan**: it records sources, trust levels, budget, exclusions, dependent facts, and invalidation conditions; compression must preserve provenance |
| Independent Verifiers | **Independent Verifiers / Verifier** (PRD 8.5 VF-01/02, 8.11) | Clarifies the verifier producer and version, runtime environment, isolation requirements independent of the Builder Loop, evidence levels, and invalidation conditions; verifiers are onboarded as governed extensions |
| Proof Package | **Proof Package + machine-readable proof export** (PRD 8.6 DP-01~04) | Fills in the per-item status of completion conditions, key rules / Context Plan / experience / model routing, Capability Lease and human decisions, unverified items and residual risks, and executable reproduction commands, and supports structured export and redaction |

In addition, PRD v1.0 introduced new frameworks **that did not yet exist** in the early draft: the evidence-native **dual-loop runtime** (Builder Loop / Assurance Loop), the **Capability Lease**, the **Autonomy Envelope**, **provenance and trust-level propagation**, **governed extensions and conformance tests**, and a **versioning and compatibility strategy** (the kernel/protocol/Schema/SDK are each semantically versioned). These are the results of systematizing on top of the early competitive positioning in order to satisfy secure and trustworthy delivery.

## 5. Differences from the Current PRD (for Reader Comparison)

- The positioning of the early draft was **competitive** (emphasizing a high success rate, understanding, and verifiable results) and did not elaborate security, privacy, or governance boundaries.
- PRD v1.0 specifies the **kernel invariants**, **default-deny**, the **six-phase threat model**, and **release quality gates**, and imposes evidence constraints on "leading" statements (PRD 13.1, 18.6).
- The early draft does not have PRD v1.0's **state machine, completion determination rules, provenance propagation rules, extension rules, and version compatibility strategy**; implementation and acceptance always follow the PRD.

---

> Reminder again: this document is a historical baseline and **has been superseded by PRD v1.0**. To learn about current product capabilities and constraints, read [`需求文档.md`](../../../需求文档.md).
