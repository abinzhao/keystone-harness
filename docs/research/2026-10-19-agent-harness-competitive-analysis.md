# Keystone Competitive Analysis

**Document date**: 2026-10-19
**Nature**: Competitive facts and product decision record
**Basis**: `需求文档.md` (PRD v1.0), Section 17 "Competitive Facts and Product Decisions" and Section 1.3 "Core Differences"
**Authoritative source of truth**: in case of conflict, `需求文档.md` prevails

> This document introduces no competitive facts beyond the PRD. Any unverified claim involving a specific product is omitted; any specific number not given by the PRD is not listed. Any "leading" statement must cite the current scorecard and reproducible experiments (PRD 13.1, 18.6).

## 1. Conclusion First

As of 2026-10-19, mainstream engineering Agent products **already generally possess** common capabilities such as a unified runtime, multiple clients, Skills, plugins, Hooks, permissions, sandboxes, session recovery, worktrees, and sub-agents.

Therefore:

- Keystone **does not claim these common capabilities themselves as innovation**.
- Keystone's difference is not in the feature list but in **how the evidence-native dual-loop runtime organizes these capabilities**: it threads Contract / Lease / Proof semantics through the work and connects tasks, workspaces, evidence, and experience through a derivable run graph.
- Keystone's positioning statement (PRD §16): **continuously understand the project, complete complex tasks within controllable boundaries, and prove with evidence that the results are deliverable.**

## 2. Market Consensus

The market consensus explicitly listed in PRD §17 (as of 2026-10-19, generally possessed by mainstream products):

- Unified runtime (multiple clients share the Agent Runtime).
- Multiple clients (desktop, CLI, IDE, etc.).
- Skills, plugins, and Hooks.
- Permissions and sandboxes.
- Session persistence and branching.
- Worktree.
- Sub-agents.
- Project rules and Auto Memory.
- Testing and code review capabilities.
- Manual / Plan / Auto modes.
- Historical experience reuse.

> These are the shared market baseline. Keystone's honest stance is: **the existence of these capabilities does not constitute a difference; how they are organized and constrained is what constitutes a difference.**

## 3. Keystone Baseline and Differences (Aligned with PRD §17)

| Market consensus | Keystone baseline | Keystone difference |
|---|---|---|
| Shared Agent Runtime across multiple clients | Desktop, CLI, IDE, and CI share the runtime | Contract, Lease, and Proof semantics are consistent across clients |
| Session persistence and branching | Branchable Run Graph | Branches connect workspaces, evidence, and experience, not just copy chat |
| Skills, plugins, and MCP | Governed extensions | Extensions cannot replace the security kernel or escalate their own privileges |
| Project rules and Auto Memory | Project World Model | Every fact has a source, time, applicable snapshot, and invalidation |
| Testing and code review | Proof Graph | Completion conditions are determined deterministically via an evidence dependency graph |
| Manual, Plan, and Auto modes | Autonomy Envelope | Autonomy is gained and decays within hard boundaries based on evidence |
| Historical experience reuse | Experience Firewall | Evaluates positive transfer, negative transfer, and forgetting together |

### 3.1 Elaboration of the Differences

Combined with the core differences in PRD §1.3, Keystone's differences can be summarized in the following points:

1. **Contract / Lease / Proof semantics are consistent across clients.** The same Keystone Run Protocol runs through desktop, CLI, IDE, and CI; protocol adapters cannot change Contract, Lease, Provenance, Evidence, or completion semantics, and semantics that cannot be expressed must be explicitly degraded or rejected, with silent loss prohibited.
2. **Branches connect workspaces, evidence, and experience, not just copy chat.** The Branchable Run Graph connects tasks, checkpoints, actions, workspaces, evidence, and experience; users can derive run branches from a valid checkpoint and independently compare results, cost, change scope, verification status, and residual risk.
3. **Governed extensions.** Extensions are activated after Manifest validation, integrity checks, dependency resolution, conformance tests, risk presentation, and user confirmation; extensions cannot grant themselves permissions or replace the state machine, authority issuance, evidence integrity, or completion determination; extensions can add restrictions or request confirmation but cannot add Allow rules or turn off security modes on their own.
4. **Provenance and invalidation of the Project World Model.** Every project fact records its content, source, derivation relations, applicable snapshot, trust level, freshness, and invalidation conditions; after the relevant code/config/dependency/tool version/Git state changes, only the affected facts, Context Plans, and Evidence are invalidated rather than rebuilding all understanding.
5. **Deterministic determination by the Proof Graph.** A task enters "proven" only when all required completion conditions pass, evidence reaches the specified level and is not invalidated, actual changes do not exceed scope, the evidence chain is complete, the workspace matches at verification time, the independence requirements are met, and the graph has no unresolved conflicts / circular dependencies / invalidated upstream nodes. Completion is a deterministic query result, not model text.
6. **Autonomy Envelope.** The user sets, per project, the maximum hard boundary within which execution may be automatic (files, commands, network, credentials, external systems, reversibility, and budget); the model, plugins, historical successes, and project content cannot automatically expand it; changes in autonomy only affect the confirmation frequency within the boundary and do not increase permissions.
7. **Experience Firewall.** Candidate experience is quarantined first and by default does not participate in subsequent tasks; promotion requires independent verification, user confirmation, or derivability from project facts and deterministic tools; positive transfer, negative transfer, and forgetting are evaluated together, and it can be demoted and revoked.

## 4. Competitive Stance: Not a Feature-Count Race

Keystone explicitly **does not claim leadership by feature count**. A stable version must, under the same model, same task, same permissions, same time, and same token budget, satisfy the cross-phase leadership gate of PRD 13.1:

1. Significantly outperform the current best reproducible experimental baseline in at least one core dimension among verification completion rate, human intervention rate, and context cost;
2. The escape defect rate, out-of-scope change rate, and lifecycle safety metrics do not degrade;
3. Recovery, replay, and branch merging have deterministic evidence;
4. After enabling long-term experience, positive transfer is observable, and negative transfer and forgetting do not exceed the release gate;
5. New plugins, models, protocols, or policies cannot break the Contract, Lease, Provenance, Evidence, and Proof invariants.

Specific numerical thresholds are determined by public baseline evaluations and **are not preset without data**; any "leading" statement must cite the current scorecard and reproducible experiments (PRD 18.6).

## 5. Evaluation and Continuous Updates

- The evaluation protocol (PRD 13.2) requires: the task set covers defect fixes, constrained features, refactoring, testing, frontend, cross-module, and long-task recovery; it uses hidden verification or independent acceptance scripts; it repeats runs and reports variance and failure types; it fixes and records the model, Harness, plugins, policies, permissions, tools, and environment versions; it runs both Standard and Minimal modes to distinguish model capability from Harness gain; long-term learning uses different task paths to separately evaluate positive transfer, negative transfer, and forgetting; and safety evaluation covers six lifecycle phases.
- Continuous competitive updates (PRD 18.6): record the capability changes of major Harnesses monthly; refresh the unified competitive matrix and comparative evaluation quarterly; trigger an impact review when a major model, protocol, plugin, or security research is released.
- Open boundaries (PRD 18.1): publish the evaluation task format, runner, metric definitions, and versioned scorecard.

## 6. To Be Confirmed and Boundaries

- This document **contains no measured data or specific numbers for any specific product**; such data must be added after public, reproducible experiments produce it.
- The specific capability details of mainstream products are governed by their official releases; this document states only the market-consensus-level facts already confirmed in PRD §17.
- The refresh cadence of the unified competitive matrix and comparative evaluation is given in PRD 18.6; this document should be updated accordingly at that time.
