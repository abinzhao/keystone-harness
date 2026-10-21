# Keystone

[简体中文](./README.md) · **English**

Keystone is an **evidence-native, local-first universal agent foundation**.

At its center is a minimal trusted kernel that works inside explicit user-set boundaries and proves completion with replayable evidence — not with the model's own say-so. Models, tools, verifiers, skills, and clients are on-demand, governed extensions. **Engineering is its first reference vertical.**

> In one line: the stable kernel answers "what is true and what is allowed"; all cognitive capability is pluggable.

## Status

**This is a developer-preview, CLI-first release**: the working tree is the `1.0.0-rc.1` candidate — the whole workspace is uniformly marked as a prerelease candidate, but it is **not** a stable 1.0.0: the root package stays `private`, nothing is published to a registry, and nothing is signed or notarized. A stable 1.0.0 still requires explicit `--allow-1.0` admission once the ROADMAP gates close (ADR-0012). Alongside the CLI, this RC includes an experimental native macOS thin window; it reuses the same Run Protocol rather than creating a second runtime, but it is not yet packaged, signed, or notarized as a distributable `.app`.

Keystone is in early implementation. The **P0 kernel, runtime, and headless CLI exist** and are exercised end to end against real Git repositories:

- An evidence-native task loop that reaches `proven` only when every required condition carries valid evidence at the required level.
- A machine-readable Outcome Contract, Capability Lease, Evidence record, and Proof Package, all defined once in `@keystone/schemas`.
- An append-only event ledger whose replay reproduces the authoritative task state.
- Checkpoints, a branchable run graph with branch comparison, recovery assessment, and precise evidence invalidation when the workspace changes.
- An Experience Firewall that keeps unverified lessons out of future tasks and demotes one as soon as a later task shows it did not help.
- A governed extension surface (manifest, integrity, conformance kit, registry) with a working reference extension.
- Governed local out-of-process capability: local `stdio` MCP tools installed through the existing extension flow, plus project/user Agent Skills discovered on disk — both treated as untrusted input, granted no capability by mere presence, with no remote transport or marketplace (ADR-0009).
- A local Run Protocol server and a four-zone workbench — the same runtime and the same schemas the CLI uses.

**Not yet done (please do not overstate):** on macOS, the desktop shell now embeds the same-origin loopback proxy in a native Swift/WKWebView window. It supervises `keystone serve`, injects the bearer token server-side, protects `/desktop/*` with a per-start nonce, and provides first-run BYOK, simple/advanced modes, risk-graded Contract preview, and terminal receipts (ADR-0008, ADR-0013). The native helper was built from source and exercised on an Apple M3 Pro, but there is **no** universal/Intel `.app`, Apple Developer ID signing, notarization, or public packaging; unsupported platforms or a missing helper degrade explicitly to the system browser. Git writes are implemented under scoped `git.write` leases, and a target path overlapping pre-existing user edits is refused with commit/stash/isolated recovery guidance (ADR-0007, ADR-0013). Windows remains unit-tested at the resolution layer only; the end-to-end suite has not run on a Windows machine.

Keystone is licensed under the [Apache License 2.0](./LICENSE).

## Why this shape

- **Evidence over claims:** completion is a deterministic query over an Outcome Contract and Proof Graph; a model saying "done" does not count.
- **Local-first:** runtime data lives under `~/.keystone/` (override with `KEYSTONE_HOME`) and is not bound to any vendor cloud.
- **Stable kernel, pluggable capability:** models and extensions may only propose actions; only the kernel can change authoritative state, issue leases, accept evidence, mark completion, or promote long-term experience.
- **Universal foundation, engineering first:** the kernel and protocols do not assume engineering semantics; engineering is the first vertical used to stress-test the foundation.

The design rationale lives in the [universal-foundation architecture](./docs/architecture/2026-10-20-keystone-universal-foundation.md); external trend evidence lives in the [future agent foundation evidence note](./docs/research/2026-10-20-future-agent-foundation-evidence.md).

## What the foundation is for

The kernel is not bound to any one vertical. **Engineering is the first — and currently the only — shipped reference vertical.** The same kernel is designed around six shared primitives — Goal/Contract, Context/Memory, Capability, Policy/Lease, Evidence/Receipt, Exception/Human decision — so it can carry personal, research, creation, enterprise, and physical-device/robotics packs. They are all added as adapters + extensions with **zero kernel change**; none is implemented yet — an architecture ambition, not a claim.

The ordinary-user end state is **zero-config progressive disclosure**: mechanics hidden by default; low-risk, clearly scoped, reversible writes without external effects may auto-start after preview when project policy permits; ambiguity, boundary expansion, irreversible/external/high-risk actions, or policy requirements still ask for confirmation; completion leaves a receipt; exceptions pause; replay stays available. The RC's macOS native window and BYOK onboarding cover this main path, but remain an unsigned, unnotarized, unpackaged developer preview.

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
pnpm run release:all  # offline SBOM + build-info + version/release-readiness check (no publish/sign)
```

CI runs install / typecheck / tests on macOS and Linux and emits the offline SBOM and build-info; a separate non-blocking Windows verification path exists but has not yet been confirmed on a real Windows machine. Release assets are written only to the git-ignored `dist/release/`; the current version is the pre-release candidate `1.0.0-rc.1`. Workspace versions move only through the authoritative `pnpm run release:bump <version>` script, and generated artifacts and the lockfile are regenerated by their own generators / `pnpm install` — never hand-edited. No script publishes, signs, or notarizes.

The kernel has **no runtime dependencies**. Packages are executed directly from TypeScript sources; there is no build step. Two constraints follow and are enforced in code review: no non-erasable syntax (`enum`, `namespace`, parameter properties, decorators); relative imports must carry an explicit `.ts` extension.

## Using the CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts ci --project . --request "fix the duplicate session refresh" --scripted-fixture fixture.json
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
node packages/cli/src/bin.ts extension install ./packages/extension-no-debug-statements
node packages/cli/src/bin.ts extension list
```

Extensions are user-governed: `extension install <local path>` verifies the manifest
digest against the real entry bytes, runs the Conformance Kit, and discloses in plain
language what it can do, whether data leaves the machine, and whether it is reversible.
An extension that can reach outside the machine is recorded only with an explicit
`--yes`, and activation passes through the gate again. There is no remote marketplace —
installation is local-path only.

For unattended/CI use, prefer `keystone ci`: it never prompts, prints one stable
JSON object on stdout (including the redacted proof artifact path), and reports
the result with the same exit codes as `task run` — `0` proven · `3` needs human
attention (not a failure) · `1` did not prove · `2` usage error. See
[docs/architecture/cli-automation-surface.md](./docs/architecture/cli-automation-surface.md).

### Configure a model (BYOK)

Keystone speaks each provider's native HTTP surface directly with the platform `fetch` — no vendor SDK. Keys are read from stdin, stored under `~/.keystone/credentials` with owner-only permissions, and never written into the config file.

Four wire protocols are supported (see [ADR-0010](./docs/adr/0010-native-model-capability-negotiation.md)):

| `--protocol` | Surface | Native tools | Structured output |
|---|---|---|---|
| `openai-chat` (default) | OpenAI-compatible Chat Completions | no (text envelope) | yes |
| `openai-responses` | OpenAI Responses | yes | yes |
| `anthropic-messages` | Anthropic Messages | yes | no (JSON validated by caller) |
| `gemini-generate` | Gemini GenerateContent | yes | yes |

> **Capability is a contract:** the descriptor only claims what the adapter implements. When a request carries tool descriptors, routing selects only adapters declared with native tools; if none on the route qualify, it fails loudly before any network call rather than silently dropping them. Streaming and multimodal are declared unimplemented in v1. Old configs without a `protocol` field remain readable and default to `openai-chat`. The native wire request/response/tool-call mappings and the capability router are implemented and covered by in-process mock-`fetch` tests; however, the v1 Builder Loop still drives the validated text envelope (`tools: []`), and no live provider call has been verified end to end.

```bash
# A hosted, OpenAI-compatible endpoint (BYOK).
node packages/cli/src/bin.ts model add --id cloud-main --kind cloud \
  --provider openai-compatible --model gpt-x \
  --base-url https://api.openai.com/v1 --endpoint-host api.openai.com \
  --credential-handle main
node packages/cli/src/bin.ts model credential set main   # paste the key on stdin

# A native vendor surface: --protocol fills the default base-url and host.
node packages/cli/src/bin.ts model add --id anth --kind cloud \
  --provider anthropic --model claude-x --protocol anthropic-messages \
  --credential-handle main

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
- [ADR-0006: Engineering vocabulary extracted to scenario packs](./docs/adr/0006-engineering-scenario-pack-extraction.md)
- [ADR-0007: Scoped Git commit lifecycle](./docs/adr/0007-scoped-git-commit-lifecycle.md)
- [ADR-0008: Desktop shell and contract confirmation](./docs/adr/0008-desktop-shell-and-contract-confirmation.md)
- [ADR-0009: Governed local MCP and Skills](./docs/adr/0009-governed-local-mcp-and-skills.md)
- [ADR-0010: Native model capability negotiation](./docs/adr/0010-native-model-capability-negotiation.md)
- [ADR-0011: ACP mapping and the stdio adapter blocker (blocked; no adapter ships)](./docs/adr/0011-acp-mapping-and-adapter-blocker.md)
- [ADR-0012: Release candidate boundary and the two-channel readiness gate](./docs/adr/0012-release-candidate-boundary.md)
- [ADR-0013: Risk-graded startup and dirty-overlap refusal](./docs/adr/0013-risk-graded-startup-and-dirty-overlap.md)

---

Keystone is released under Apache-2.0. Language affects only human-readable text; protocol field names, event types, schema validation paths, and the proof package are language-neutral machine formats — the proof package in particular is content-addressed and must be byte-identical regardless of the language a run was displayed in.
