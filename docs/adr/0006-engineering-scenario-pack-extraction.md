# ADR-0006: Engineering Vocabulary Extracted to Scenario Packs

- **Status**: Accepted (amended 2026-10-20, M1 — action capability/resource resolution and spawn-target home)
- **Date**: 2026-10-20
- **Decision basis**: [2026-10-20 universal foundation](../architecture/2026-10-20-keystone-universal-foundation.md) §1, §5, §8, §9; AGENTS.md §2 (kernel invariants), §3 (package boundaries)
- **Relates to**: ADR-0001 (evidence-native loop), ADR-0002 (kernel is sole state authority), ADR-0004 (zero runtime deps), ADR-0005 (local-first storage)

## Context

The universal-foundation architecture states the kernel contains **no engineering-only semantics**: "Project", "build", and "test" are adapter/extension concepts, not kernel concepts; engineering is the reference vertical that ships first, not the semantic core. An audit of `packages/kernel` found three modules that were pure engineering implementation living inside the trusted, replayable kernel package:

| Module | Engineering vocabulary it carried |
|---|---|
| `src/project/scan.ts` | Git work-tree detection (`git rev-parse`, `ls-files`, `status --porcelain`), `node_modules`/`dist`/`coverage` exclusions, `package.json` script discovery, `pnpm`/`yarn`/`npm` lockfile detection, TypeScript/Python/Go extension language guessing, `AGENTS.md`/`CLAUDE.md`/`.cursor/rules` detection |
| `src/exec/spawn-target.ts` | Windows `.cmd`/`.bat` shim resolution for `npm`/`pnpm`/`yarn`/`npx`/`corepack`, `cmd.exe` argument escaping (cross-spawn algorithm) |
| `src/contract/compile.ts` | Engineering contract-proposal heuristics: `node_modules/**`/`dist/**`/`*.lock` write-scope exclusions, test/typecheck/lint verifier emission from `package.json` scripts, preserve-behaviour/test keywords |

These are side-effecting or domain-heuristic helpers that happened to be exported from the kernel. Keeping them in `@keystone/kernel` means the trusted, independently replayable package ships engineering assumptions — the very thing the foundation reframing forbids.

## Decision

**Move the pure engineering implementations into a new reference-vertical package `@keystone/pack-engineering`.**

1. **The pack owns its domain vocabulary.** `packages/pack-engineering` holds: Git/workspace scanning and profiling (`scanWorkspace`, `detectProjectProfile`, `NotAGitRepositoryError`), the engineering Outcome-Contract proposal (`compileContract`), and the engineering action policy (`resolveEngineeringAction`). It depends on `@keystone/kernel` and `@keystone/schemas` — the same downward-only, peer-to-extension posture as `@keystone/tools`, `@keystone/verifiers`, and `@keystone/extensions`. It never is depended upon by the kernel.

2. **Kernel invariants are unchanged.** I1–I8 hold verbatim. The kernel still is the sole writer of task state; the moved code never wrote authoritative state itself — `scanWorkspace` was a pure helper, and `compileContract`/`resolveEngineeringAction` only *proposed* or *resolved* what the kernel then folded into events. The kernel gains no new dependency; in fact it loses the engineering imports.

3. **The contract proposal becomes an injected strategy, not an import.** `KernelSession` cannot call `compileContract` (that would make the kernel depend on the pack — a cycle). Instead the kernel defines a generic `ContractProposer` seam (`ContractProposalInput` → `ContractProposal`) and the composition root (`@keystone/runtime`) wires the engineering implementation. If a session is compiled without a proposer, the kernel raises a loud error rather than fabricating engineering content. The state-machine side — requiring the `defining` status, appending `contract.compiled`, transitioning on the produced status, and returning the questions — remains entirely in the kernel.

4. **Action capability/resource resolution is also an injected policy (M1).** A follow-up audit found the kernel still hard-coded the engineering mapping from a model `intent` to a `Capability` (`read`→`fs.read`, `execute`→`cmd.exec`, …) and from a tool id to its lease resource values (`fs.write_file`→its `path` parameter, `cmd.run`→its `command`, …). That mapping is scenario/composition policy, not kernel authority. The kernel now defines a generic `ActionCapabilityResolver` seam (`ActionProposal` → `{ capability, resourceValues }`) that it owns but does not implement; the engineering implementation (`resolveEngineeringAction`) lives in the pack and is wired by `@keystone/runtime` alongside the proposer. Two failure modes stay deliberately distinct:
   - **No resolver wired** — a composition error. Calling `authorize` then throws a loud `KernelError` (`no_action_resolver`), mirroring compiling without a `ContractProposer`.
   - **A wired resolver returns `capability === undefined`** — the ordinary default-denial. The kernel records `action.rejected` (`resource_not_in_lease`) and returns the refusal, exactly as before.
   The lease decision itself — scope, Autonomy Envelope, issuance/refusal, the `lease.issued` / `action.rejected` events — remains entirely in the kernel. The resolver is runtime-side policy that is never written to the ledger, so `foldTaskState` and `replay()` never consult it: resumed and replayed sessions are unaffected.

5. **Public Schema versions are unchanged.** No file under `packages/schemas` is edited; `keystone.contract.outcome@1.0.0` and all other `schemaVersion` values are untouched. The moved functions still parse and emit the *same* schema objects, byte-for-byte in behaviour.

6. **Compatibility strategy.**
   - The kernel drops the moved re-exports from `packages/kernel/src/index.ts` (they were the leak). It keeps storage-layout primitives it genuinely owns (`projectIdForWorkspace`, `readJsonFile`, `globToRegExp`); the pack imports those from the kernel.
   - Existing consumers — `@keystone/runtime`, `@keystone/cli`, `@keystone/tools`, `@keystone/verifiers` — repoint their imports of the moved symbols at the new owners. No public schema or wire object changes shape, so no consumer migration beyond an import path is required.
   - Focused tests that pinned the engineering behaviour move with the code into `packages/pack-engineering/test`, proving identical outputs.

7. **Spawn-target resolution moves to a neutral package, not the engineering pack (M1).** `resolveSpawnTarget` (Windows `.cmd`/`.bat` shim resolution and `cmd.exe` argument escaping) is generic process-launch compatibility, not engineering vocabulary. It initially landed in `pack-engineering`, but that made the two *generic* execution boundaries — `@keystone/tools` (actions) and `@keystone/verifiers` (checks) — depend on an engineering scenario pack just to run a command, an inverted layering. It now lives in a new zero-dependency bottom layer `@keystone/spawn`, which both boundaries depend on directly. It carries no task, contract, scope, or scenario vocabulary and launches nothing itself.

## Deferred boundary (schema genericization is explicitly out of scope)

This phase relocates code; it does **not** genericize the schema. The injected proposer seam is still typed to today's engineering schemas — `ProjectProfile`, `ProjectFact`, and the engineering verifier kinds (`test`/`typecheck`/`lint`/`diff_scope`/`project_rule`). Renaming `ProjectProfile` into a scenario-agnostic `ContextProfile`, or parameterizing the verifier catalog, is **deferred** until a second real scenario pack exists and the abstraction can be drawn against two concrete shapes rather than guessed against one. Doing it now would be speculative generalization that risks churning schema versions the task forbids.

## Consequences

- `@keystone/kernel` no longer references git, package managers, lockfiles, Windows `.cmd` shims, engineering scope exclusions, *or* any intent→capability / tool→resource mapping. Its surface shrinks; it stays replayable standalone.
- Engineering behaviour is observable-identical: the same scans, the same profiles, the same resolved spawn targets, the same proposed contracts, and the same action→capability/resource resolutions are produced, now from the pack (or `@keystone/spawn`).
- A future non-engineering pack (research, personal, …) can supply its own `ContractProposer`, its own `ActionCapabilityResolver`, its own context detector, and its own verifiers with **zero kernel change** — which is the ROADMAP "Universal-foundation layering" exit gate.
- Cost: the composition root (runtime) now owns wiring the engineering proposer **and** the engineering action resolver; `KernelSession.create` (and, for a reopened session that continues to act, `KernelSession.open`) accepts optional `proposeContract` and `resolveAction`. There is exactly one production caller (the runtime), which wires both. Resumed/replay-only paths need neither and are unchanged.
- `@keystone/tools` and `@keystone/verifiers` depend on the zero-dependency `@keystone/spawn` for cross-platform launching; they no longer depend on the engineering pack at all.

## Rejected alternatives

- **Keep the code in the kernel and mark it `@deprecated`:** leaves engineering vocabulary in the trusted package and still exports it — does not satisfy the exit gate.
- **Let the kernel import `@keystone/pack-engineering`:** creates a `kernel → pack → kernel` cycle, breaks the one-way dependency rule (AGENTS.md §3), and makes the kernel un-replayable standalone (I7).
- **Genericize the schema now** (`ProjectProfile` → `ContextProfile`, parameterized verifier kinds): demands schema-version bumps and renames the task explicitly defers; buys nothing until a second pack exists.
- **Keep the intent→capability/tool→resource mapping in the kernel** (read from a config table, or leave it hard-coded): keeps engineering vocabulary in the trusted, replayable package and lets a second scenario change capabilities only by editing the kernel — defeats the exit gate. An injected resolver seam keeps the kernel neutral while preserving default-deny.
- **Leave `resolveSpawnTarget` in `pack-engineering`**: forces the generic `tools`/`verifiers` boundaries to depend on an engineering scenario pack just to launch a process; a neutral zero-dependency `@keystone/spawn` removes the inversion at no schema or state cost.
