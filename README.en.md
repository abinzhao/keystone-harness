# Keystone

[简体中文](./README.md) · **English**

Keystone is a local-first runtime for engineering agents. It separates task goals, authority, execution, verification, and proof: the model proposes actions, the kernel enforces boundaries, and verification determines whether the task is complete.

## Status

The repository is currently at `1.0.0-rc.1` and is intended for developers evaluating or integrating an agent runtime.

- The kernel, runtime, CLI, local Run Protocol, and web workbench are implemented.
- The native macOS window can be built from source, but no signed, notarized, or universal installer is available.
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

Two reference extensions live under `packages/extension-*`.

## Known Limits

- Only the engineering scenario pack is currently implemented; a generic extension boundary does not mean other domains are ready.
- Native model protocols are covered by in-process mock-`fetch` tests, not live provider end-to-end verification.
- Windows coverage is limited to unit tests such as process resolution; end-to-end behavior is still unverified.
- The macOS window is a source-level preview, not a distributable application.
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
