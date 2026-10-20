# Keystone

[简体中文](./README.md) · **English**

Keystone is an **evidence-native, local-first universal agent foundation**.

At its center is a minimal trusted kernel that works inside explicit user-set boundaries and proves completion with replayable evidence — not with the model's own say-so. Models, tools, verifiers, skills, and clients are on-demand, governed extensions. **Engineering is its first reference vertical.**

> In one line: the stable kernel answers "what is true and what is allowed"; all cognitive capability is pluggable.

## Status

**This is a developer-preview, CLI-first release**: aimed at developers who are comfortable driving the kernel from a command line; the ordinary-user desktop shell is not implemented.

Keystone is in early implementation. The **P0 kernel, runtime, and headless CLI exist** and are exercised end to end against real Git repositories:

- An evidence-native task loop that reaches `proven` only when every required condition carries valid evidence at the required level.
- A machine-readable Outcome Contract, Capability Lease, Evidence record, and Proof Package, all defined once in `@keystone/schemas`.
- An append-only event ledger whose replay reproduces the authoritative task state.
- Checkpoints, a branchable run graph with branch comparison, recovery assessment, and precise evidence invalidation when the workspace changes.
- An Experience Firewall that keeps unverified lessons out of future tasks and demotes one as soon as a later task shows it did not help.
- A governed extension surface (manifest, integrity, conformance kit, registry) with a working reference extension.
- A local Run Protocol server and a four-zone workbench — the same runtime and the same schemas the CLI uses.

**Not yet done (please do not overstate):** the desktop shell (the planned thin Tauri wrapper) is not built; Git write operations (commit / rollback) are not implemented yet — today it is read-only Git tools plus `git worktree` isolation; Windows is implemented and unit-tested at the resolution layer, but the end-to-end suite has not yet been run on a Windows machine. See [ROADMAP.md](./ROADMAP.md) for milestones and entry/exit gates.

Keystone is licensed under the [Apache License 2.0](./LICENSE).

## Why this shape

- **Evidence over claims:** completion is a deterministic query over an Outcome Contract and Proof Graph; a model saying "done" does not count.
- **Local-first:** runtime data lives under `~/.keystone/` (override with `KEYSTONE_HOME`) and is not bound to any vendor cloud.
- **Stable kernel, pluggable capability:** models and extensions may only propose actions; only the kernel can change authoritative state, issue leases, accept evidence, mark completion, or promote long-term experience.
- **Universal foundation, engineering first:** the kernel and protocols do not assume engineering semantics; engineering is the first vertical used to stress-test the foundation.

The design rationale lives in the [universal-foundation architecture](./docs/architecture/2026-10-20-keystone-universal-foundation.md); external trend evidence lives in the [future agent foundation evidence note](./docs/research/2026-10-20-future-agent-foundation-evidence.md).

## What the foundation is for

The kernel is not bound to any one vertical. **Engineering is the first — and currently the only — shipped reference vertical.** The same kernel is designed around six shared primitives — Goal/Contract, Context/Memory, Capability, Policy/Lease, Evidence/Receipt, Exception/Human decision — so it can carry personal, research, creation, enterprise, and physical-device/robotics packs. They are all added as adapters + extensions with **zero kernel change**; none is implemented yet — an architecture ambition, not a claim.

The ordinary-user end state is **zero-config progressive disclosure**: mechanics hidden by default, a preview before any irreversible action, a receipt after completion, a pause at exceptions, and on-demand replay. Today's shipped surface is still the **developer surface** (SDK / protocol / debug / eval); the ordinary-user desktop shell is not built.

## Layout

| Package | Responsibility |
|---|---|
| [`@keystone/schemas`](./packages/schemas) | Authoritative schemas, validators, canonical encoding and content addressing |
| [`@keystone/kernel`](./packages/kernel) | Ledger, state machine, contracts, leases, run graph, evidence, proof, experience, checkpoints |
| [`@keystone/tools`](./packages/tools) | Filesystem, search, command execution and git tools behind a lease check |
| [`@keystone/verifiers`](./packages/verifiers) | Test, typecheck, lint, build, scope and project-rule verifiers |
| [`@keystone/models`](./packages/models) | BYOK OpenAI-compatible adapters, a deterministic offline adapter, routing |
| [`@keystone/runtime`](./packages/runtime) | Composition root: Builder and Assurance loops, context planning, autonomy, the local Run Protocol server |
| [`@keystone/extensions`](./packages/extensions) | Manifest validation, integrity, install review, conformance kit, registry |
| [`@keystone/i18n`](./packages/i18n) | Presentation-layer localisation: language resolution and the zh-CN/en catalogs |
| [`@keystone/cli`](./packages/cli) | Headless client: intake, runs, recovery, branching, proof export, replay |
| [`@keystone/extension-no-debug-statements`](./packages/extension-no-debug-statements) | Reference extension: a verifier a contributor can copy |

## Quick start

Requires Node.js `>=22.18.0` (native TypeScript type stripping) and pnpm 8.

```bash
pnpm install          # link workspace packages
pnpm run typecheck    # tsc, no build step
pnpm test             # node:test over packages/*/test
pnpm run verify       # typecheck + tests
```

The kernel has **no runtime dependencies**. Packages are executed directly from TypeScript sources; there is no build step. Two constraints follow and are enforced in code review: no non-erasable syntax (`enum`, `namespace`, parameter properties, decorators); relative imports must carry an explicit `.ts` extension.

## Using the CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
```

### Configure a model (any OpenAI-compatible endpoint)

Keystone talks the OpenAI Chat Completions shape with no vendor SDK, so the OpenAI API itself, Azure-compatible gateways, OpenRouter, and local runtimes (Ollama / LM Studio / vLLM / llama.cpp / LocalAI) all work. Keys are read from stdin, stored under `~/.keystone/credentials` with owner-only permissions, and never written into the config file.

> **Today's model boundary:** only **text completion over an OpenAI-compatible Chat Completions interface** is supported. The native Responses API, native function/tool-calling protocol, Anthropic Messages, and Gemini native endpoints are **not current capabilities** — they are planned. The model only produces action proposals and observations over this interface; working without vendor-specific features is the point of local-first.

```bash
# A hosted, OpenAI-compatible endpoint (BYOK).
node packages/cli/src/bin.ts model add --id cloud-main --kind cloud \
  --provider openai-compatible --model gpt-x \
  --base-url https://api.openai.com/v1 --endpoint-host api.openai.com \
  --credential-handle main
node packages/cli/src/bin.ts model credential set main   # paste the key on stdin

# A local endpoint (Ollama example): no credential, no data leaves the machine.
node packages/cli/src/bin.ts model add --id local-ollama --kind local \
  --provider ollama --model llama3.1 \
  --base-url http://127.0.0.1:11434/v1 --endpoint-host 127.0.0.1

node packages/cli/src/bin.ts model route builder cloud-main
node packages/cli/src/bin.ts doctor
```

For offline runs and evaluation there is a deterministic scripted model (`--scripted-fixture <file.json>`); it is not an intelligence and reports zero token usage rather than an estimate.

## Workbench

The runtime can serve itself to a shell over the Keystone Run Protocol:

```bash
node packages/cli/src/bin.ts serve --port 7801
```

It listens on loopback only and prints a bearer token. Run modes are selectable per run and per server: `minimal` (deterministic checks only, no model), `standard`, `isolated` (a separate Git worktree so the working copy is untouched), and `replay`.

```bash
node packages/cli/src/bin.ts protocol export --out ./protocol   # JSON Schema for every object
pnpm run bench                                                  # the performance baseline harness
```

## Architectural commitments

- Completion is a deterministic query over an Outcome Contract and Proof Graph.
- Every side effect requires a scoped, short-lived Capability Lease.
- Context, memory, evidence, and derived state retain provenance and invalidation rules.
- Long-term experience is quarantined, evaluated, promoted, and demoted through an Experience Firewall.
- Autonomy can increase or decay only inside user-defined hard boundaries.
- The kernel is stable; models, tools, workspaces, analyzers, verifiers, skills, clients, and protocol adapters are governed extensions.
- A Minimal Runtime remains available for evaluation, diagnosis, and safe degradation.

## Documents

- [Product requirements](./需求文档.md) (Chinese)
- [Next-generation product strategy (2026-10-20)](./docs/product/2026-10-20-keystone-next-generation-product-strategy.md)
- [Product strategy report · HTML (2026-10-20)](./docs/product/2026-10-20-keystone-next-generation-report.html)
- [Universal-foundation architecture (2026-10-20)](./docs/architecture/2026-10-20-keystone-universal-foundation.md)
- [Future agent foundation evidence (2026-10-20)](./docs/research/2026-10-20-future-agent-foundation-evidence.md)
- [Competitive analysis (2026-10-19)](./docs/research/2026-10-19-agent-harness-competitive-analysis.md)
- [Roadmap](./ROADMAP.md)
- [Contributing](./CONTRIBUTING.md) · [Governance](./GOVERNANCE.md) · [Security policy](./SECURITY.md) · [Support](./SUPPORT.md)

### Architecture decision records

- [ADR-0001: Evidence-native dual loop](./docs/adr/0001-evidence-native-dual-loop.md)
- [ADR-0002: Kernel is the sole state authority](./docs/adr/0002-kernel-is-sole-state-authority.md)
- [ADR-0003: Event-sourced task ledger](./docs/adr/0003-event-sourced-task-ledger.md)
- [ADR-0004: TypeScript with zero runtime dependencies](./docs/adr/0004-typescript-zero-runtime-dependencies.md)
- [ADR-0005: Local-first storage layout](./docs/adr/0005-local-first-storage-layout.md)

---

Keystone is released under Apache-2.0. Language affects only human-readable text; protocol field names, event types, schema validation paths, and the proof package are language-neutral machine formats — the proof package in particular is content-addressed and must be byte-identical regardless of the language a run was displayed in.
