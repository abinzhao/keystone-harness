# Keystone

[简体中文](./README.md) · **English**

Keystone is a local-first runtime for engineering agents. It separates task goals, authority, execution, verification, and proof: the model proposes actions, the kernel enforces boundaries, and verification determines whether the task is complete.

## Status

The repository is currently at `1.0.0-rc.1` and is intended for developers evaluating or integrating an agent runtime.

- The kernel, runtime, CLI, local Run Protocol, and web workbench support read-only analysis, recorded model answers, scoped changes, and independent proof.
- The workbench supports file recovery drafts, input model selection, and task configuration snapshots. Recovery drafts never save themselves to source files.
- A local macOS application can be packaged with embedded Node; no signed, notarized, or universal installer is available.
- The root and all workspace packages are `private` and are not published to npm.
- macOS is the primary verified platform, and CI also targets Linux. Windows has a non-blocking verification job but no completed end-to-end run on Windows hardware.

This is still a release candidate and should not be treated as an unattended production executor.

## Design

- **Evidence decides completion.** A task reaches `proven` only after every completion condition has valid evidence.
- **Capability leases constrain side effects.** Filesystem, command, Git, and network operations must match a scoped, short-lived Capability Lease.
- **State is replayable.** Authoritative state comes from an append-only event ledger, not model output or client caches.
- **Provenance travels with data.** Context, observations, evidence, and experience retain their source, trust level, and invalidation rules.
- **Extensions cannot grant themselves authority.** Models, tools, verifiers, and Skills may add capability, but they cannot replace kernel authorization or completion decisions.

See the [architecture overview](./docs/architecture/overview.md) for the complete boundary.

## Quick Start

Requires Node.js `>=22.18.0` and pnpm `8.15.9`.

```bash
pnpm install
pnpm run verify
node packages/cli/src/bin.ts doctor
node packages/cli/src/bin.ts project inspect .
```

The repository runs directly from TypeScript source and has no build or transpilation step.

### Configure a Model

Keystone uses bring-your-own-key model access. Credentials are read from stdin, stored under `~/.keystone/credentials`, and never written to project configuration.

```bash
node packages/cli/src/bin.ts model add \
  --id local-ollama \
  --kind local \
  --provider ollama \
  --model llama3.1 \
  --base-url http://127.0.0.1:11434/v1 \
  --endpoint-host 127.0.0.1

node packages/cli/src/bin.ts model route builder local-ollama
```

Cloud adapters support OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini GenerateContent. Native provider protocols supply their default endpoints; custom compatible endpoints require an explicit URL, host, and credential handle.

### Run a Task

```bash
node packages/cli/src/bin.ts task run \
  --project . \
  --request "fix the duplicate session refresh"
```

Select read-only analysis in the workbench. The CLI accepts `--model <registered-id>`
to select a model for a new task. Model answers remain untrusted observations
and cannot establish engineering proof.

Use `keystone ci` for unattended runs. It writes one stable JSON object to stdout and uses exit codes to distinguish proven, human attention required, not proven, and usage errors:

```bash
node packages/cli/src/bin.ts ci \
  --project . \
  --request "fix the duplicate session refresh" \
  --scripted-fixture ./fixture.json
```

See the [CLI automation contract](./docs/architecture/cli-automation-surface.md) for details.

### Start the Local Workbench

```bash
node packages/cli/src/bin.ts serve --port 7801
```

The service listens on loopback only and prints an access token at startup.

### TRAE CLI Model Plugin

Open “Extensions → TRAE CLI model” to detect the installation, discover models,
and check generation compatibility. Activation requires generation and isolation
checks for the exact reviewed configuration. The CLI handles its own native
login; Keystone never reads login secrets. Cloud inputs still travel to explicitly
authorized cloud hosts.

The corrected `0.210.1` transport disables independent Argos tracing and pins
metrics/file-log endpoints to HTTPS. Live generation checks passed and
`Seed-2.1-Turbo` is enabled on this machine; new installations still need their
own review and checks. HTTPS telemetry may still occur; plaintext remains denied.
See the
[plugin guide](./packages/extension-trae-cli/README.md).

### Package a Local macOS Application

```bash
node packages/desktop/scripts/package-local.ts --out /tmp/keystone-local-package
/tmp/keystone-local-package/Keystone.app/Contents/MacOS/keystone-start --self-check
```

The output directory must not exist. The native window supports both architectures;
embedded Node uses the build host architecture. Local packaging does not establish
signing, notarization, or cross-platform release readiness.

## Workspace

| Package | Responsibility |
|---|---|
| `@keystone/schemas` | Authoritative schemas, runtime validation, canonical encoding, and content addressing |
| `@keystone/kernel` | Event ledger, state machine, contracts, leases, evidence, proof, and experience |
| `@keystone/spawn` | Cross-platform child-process launch compatibility |
| `@keystone/tools` | Filesystem, search, command, and Git tools |
| `@keystone/verifiers` | Test, typecheck, lint, build, scope, and project-rule verifiers |
| `@keystone/models` | BYOK model adapters and routing |
| `@keystone/extensions` | Extension manifests, integrity checks, registry, and conformance tests |
| `@keystone/pack-engineering` | Engineering project analysis, contract proposals, and capability mapping |
| `@keystone/i18n` | Chinese and English presentation text for the CLI and workbench |
| `@keystone/runtime` | Builder/Assurance loops, context, autonomy, intervention, and local service |
| `@keystone/cli` | Project, task, proof, replay, model, and extension commands |
| `@keystone/desktop` | Supervised macOS WKWebView thin shell |
| `@keystone/extension-trae-cli` | Inactive-by-default, lease-authorized and OS-confined CLI model transport |

Reference extensions and the CLI model plugin live under `packages/extension-*`.

## Known Limits

- Only the engineering scenario pack is currently implemented; a generic extension boundary does not mean other domains are ready.
- Native model protocols are covered by in-process mock-`fetch` tests, not live provider end-to-end verification.
- Windows coverage is limited to unit tests such as process resolution; end-to-end behavior is still unverified.
- Local macOS applications can be packaged and self-checked; public distribution still requires signing, notarization, and release verification.
- TRAE CLI currently supports verified macOS 0.210.1 only. Invalid model output is refused; forbidden native activity quarantines the plugin.
- ACP integration remains blocked; no ACP adapter ships.

See the [roadmap](./ROADMAP.md) for progress and admission criteria.

## Documentation and Contributing

- [Documentation index](./docs/README.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Governance](./GOVERNANCE.md)
- [Changelog](./CHANGELOG.md)

Before submitting a contribution, run:

```bash
pnpm run verify
pnpm run release:check
```

## License

[Apache License 2.0](./LICENSE)
