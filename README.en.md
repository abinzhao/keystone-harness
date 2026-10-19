# Keystone

[简体中文](./README.md) · **English**

Keystone is an evidence-native, local-first engineering agent harness.

It is designed to understand a software project over time, execute complex engineering tasks inside explicit user boundaries, and prove completion with replayable evidence rather than model claims.

## Status

Keystone is in early implementation. The P0 kernel, runtime and headless CLI
exist and are exercised end to end against real Git repositories:

- An evidence-native task loop that reaches `proven` only when every required
  condition has valid evidence at the required level.
- A machine-readable Outcome Contract, Capability Lease, Evidence record and
  Proof Package, all defined once in `@keystone/schemas`.
- An append-only ledger whose replay reproduces the authoritative task state.
- Checkpoints, run branches with comparison, recovery assessment, and precise
  evidence invalidation when the workspace changes.
- An Experience Firewall that keeps unverified lessons out of future tasks, and
  demotes a lesson as soon as a later task shows it did not help.
- A governed extension surface (manifest, integrity, conformance kit, registry)
  with a working reference extension.
- A local Run Protocol server and a four-zone workbench — the same runtime and
  the same schemas the CLI uses, so a desktop shell has a seam to talk to.

The desktop shell itself is not built yet; Tauri is the intended thin wrapper
around the workbench that already exists. See [ROADMAP.md](./ROADMAP.md) for
milestone status.

Keystone is licensed under the [Apache License 2.0](./LICENSE).

## Layout

| Package | Responsibility |
|---|---|
| [`@keystone/schemas`](./packages/schemas) | Authoritative schemas, validators, canonical encoding and content addressing |
| [`@keystone/kernel`](./packages/kernel) | Ledger, state machine, contracts, leases, evidence, proof, experience, checkpoints |
| [`@keystone/tools`](./packages/tools) | Filesystem, search, command execution and git tools behind a lease check |
| [`@keystone/verifiers`](./packages/verifiers) | Tests, typecheck, lint, build, scope and project-rule verifiers |
| [`@keystone/models`](./packages/models) | BYOK OpenAI-compatible adapters, a deterministic offline adapter, routing |
| [`@keystone/runtime`](./packages/runtime) | Composition root: Builder and Assurance loops, context planning, autonomy, the local Run Protocol server |
| [`@keystone/extensions`](./packages/extensions) | Manifest validation, integrity, install review, conformance kit, registry |
| [`@keystone/i18n`](./packages/i18n) | Presentation-layer localisation: language resolution and the zh-CN/en catalogs |
| [`@keystone/cli`](./packages/cli) | Headless client: intake, runs, recovery, branching, proof export, replay |
| [`@keystone/extension-no-debug-statements`](./packages/extension-no-debug-statements) | Reference extension: a verifier a contributor can copy |

## Core Direction

Keystone uses an evidence-native dual-loop architecture:

- **Builder Loop** understands, plans, edits, and executes.
- **Assurance Loop** controls outcomes, context, capabilities, verification, completion, learning, and autonomy.

Both loops write to a branchable run graph. Models and extensions may propose actions, but only the stable kernel can change authoritative task state, issue capability leases, accept evidence, mark completion, or promote long-term experience.

## Platform Support

Keystone runs on **macOS and Windows** (and POSIX in general); it has no
platform-specific runtime dependency beyond Node.js and Git.

- Command execution never uses a shell on POSIX. On Windows, package-manager
  launchers (`npm`, `pnpm`, `yarn`, `npx`) are `.cmd` shims that cannot be
  spawned directly, so they are run through `cmd.exe` with the arguments
  escaped for it; native executables are still launched directly. A spawned
  process group is killed on timeout on POSIX, and on Windows only the direct
  child is terminated — a known limitation.
- Temporary files use the platform's temp directory (`TMPDIR`/`TEMP`/`TMP`),
  and credential files request owner-only permissions on a best-effort basis
  (Windows only honours the read-only bit).
- **macOS is verified on real hardware. Windows support is implemented and unit
  tested at the resolution layer, but the end-to-end suite has not yet been run
  on a Windows machine; treat Windows as preview.**

## Layout and Language

Keystone speaks **Simplified Chinese (default) and English**. The language
affects only text a human reads — CLI output, help summaries, the workbench UI
and error messages. Protocol field names, event types, schema validation paths
and the proof package are language-neutral and stay English, because they are
machine formats; the proof package in particular is a hash-addressed artifact
that must be byte-identical regardless of the language a run was displayed in.

Choose a language with, in order of precedence:

```bash
node packages/cli/src/bin.ts task list --lang en     # per invocation
KEYSTONE_LANG=en node packages/cli/src/bin.ts task list   # per environment
```

or set `"language": "en"` in `~/.keystone/config.json`.

## Documents

- [Product requirements](./需求文档.md) (Chinese)
- [Competitive analysis](./docs/research/2026-10-19-agent-harness-competitive-analysis.md)
- [Next-generation architecture](./docs/architecture/2026-10-19-keystone-next-generation-harness-architecture.md)
- [Roadmap](./ROADMAP.md)
- [Contributing](./CONTRIBUTING.md)
- [Governance](./GOVERNANCE.md)
- [Security policy](./SECURITY.md)
- [Historical competitive design](./docs/superpowers/specs/2026-10-19-keystone-competitive-product-design.md)

### Architecture decision records

- [ADR-0001: Evidence-native dual loop](./docs/adr/0001-evidence-native-dual-loop.md)
- [ADR-0002: Kernel is the sole state authority](./docs/adr/0002-kernel-is-sole-state-authority.md)
- [ADR-0003: Event-sourced task ledger](./docs/adr/0003-event-sourced-task-ledger.md)
- [ADR-0004: TypeScript with zero runtime dependencies](./docs/adr/0004-typescript-zero-runtime-dependencies.md)
- [ADR-0005: Local-first storage layout](./docs/adr/0005-local-first-storage-layout.md)

## Development

Requires Node.js `>=22.18.0` (native TypeScript type stripping) and pnpm 8.

```bash
pnpm install          # link workspace packages
pnpm run typecheck    # tsc, no build step
pnpm test             # node:test over packages/*/test
pnpm run verify       # typecheck + tests
```

The kernel has **no runtime dependencies**. Packages are executed directly from
TypeScript sources; there is no build step. Two constraints follow from that and
are enforced in code review:

- No non-erasable syntax (`enum`, `namespace`, parameter properties, decorators).
- Relative imports must carry an explicit `.ts` extension.

Runtime data lives outside any managed repository, under `~/.keystone/`
(override with `KEYSTONE_HOME`). See
[ADR-0005](./docs/adr/0005-local-first-storage-layout.md).

## Using the CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
```

(`pnpm run keystone <args>` forwards the same arguments, but not after a bare
`--` with pnpm 8.)

Set `KEYSTONE_HOME` to keep runtime data somewhere other than `~/.keystone`.

### Configure a model (any OpenAI-compatible endpoint)

Keystone talks to models over the **OpenAI Chat Completions API**
(`POST {baseUrl}/chat/completions`) with no vendor SDK, so anything that speaks
that format works: the OpenAI API itself, Azure OpenAI–compatible gateways,
OpenRouter, and local runtimes such as **Ollama, LM Studio, vLLM, llama.cpp** or
**LocalAI**. A cloud endpoint is `--kind cloud` and needs a credential; a
self-hosted endpoint is `--kind local` and usually needs none.

Keys are read from stdin and stored under `~/.keystone/credentials` with
owner-only permissions, never in the config file.

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

# LM Studio defaults to http://127.0.0.1:1234/v1, vLLM to http://127.0.0.1:8000/v1.

node packages/cli/src/bin.ts model route builder cloud-main
node packages/cli/src/bin.ts doctor
```

For offline runs and evaluation there is a deterministic scripted model
(`--scripted-fixture <file.json>`); it is not an intelligence and reports zero
token usage rather than an estimate.

Two properties are worth checking directly, because they are the point of the
project: a model claiming it is finished never completes a task, and a task is
only `proven` when every required condition carries valid evidence — see
`packages/runtime/test/acceptance.test.ts`.

## Workbench

The runtime can serve itself to a shell over the Keystone Run Protocol:

```bash
node packages/cli/src/bin.ts serve --port 7801
```

It listens on loopback only and prints a bearer token; open the printed URL, which
carries the token in the fragment (browsers never send fragments to a server).
The page is a real four-zone workbench — task list, goal and completion
conditions, proof and evidence, and a place to answer interventions — with no
build step and no dependencies, because a desktop shell would wrap exactly this.
The workbench is localised too; the server injects the catalog for the resolved
language, so `--lang en` gives an English UI.

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7801/v1/capabilities
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7801/v1/tasks
```

Run modes are selectable per run and per server: `minimal` (deterministic checks
only, no model), `standard`, `isolated` (a separate Git worktree so the working
copy is untouched) and `replay`. Scheme export uses the same authority as
validation:

```bash
node packages/cli/src/bin.ts protocol export --out ./protocol   # JSON Schema for every object
pnpm run bench                                                  # the performance baseline harness
```

## Architectural Commitments

- Completion is a deterministic query over an Outcome Contract and Proof Graph.
- Every side effect requires a scoped, short-lived Capability Lease.
- Context, memory, evidence, and derived state retain provenance and invalidation rules.
- Long-term experience is quarantined, evaluated, promoted, and demoted through an Experience Firewall.
- Autonomy can increase or decay only inside user-defined hard boundaries.
- The kernel is stable; models, tools, workspaces, analyzers, verifiers, skills, clients, and protocol adapters are governed extensions.
- A Minimal Runtime remains available for evaluation, diagnosis, and safe degradation.

## Interoperability Direction

Keystone will use existing standards at their intended boundaries:

- Open Responses for model-provider interoperability.
- MCP for tools and external resources.
- ACP for IDE and agent-client integration.
- Agent Skills for reusable capability packages.
- A2A for future remote agent collaboration.
- Keystone Run Protocol for Outcome Contract, Capability Lease, provenance, evidence, proof, checkpoints, and interventions.

## Open-Source Readiness

Before external contributions open, the project will add:

- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `GOVERNANCE.md`
- `SUPPORT.md`
- `ROADMAP.md`
- `CHANGELOG.md`
- `AGENTS.md`

The extension SDK, schemas, conformance kit, migration rules, threat model, architecture decisions, and release scorecards are intended to remain public.
