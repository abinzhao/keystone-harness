# Documentation

The root [README](../README.en.md) is the starting point for installation and use. This directory contains maintained technical documentation and decision records.

## Architecture

- [Architecture overview](./architecture/overview.md): package boundaries, authority flow, storage, execution, evidence, and extensions.
- [CLI automation surface](./architecture/cli-automation-surface.md): stable JSON output and exit-code contract for unattended runs.
- [Performance baseline](./performance/baseline-2026-10-19.md): measurement method, results, and known gaps for the first local-runtime baseline.

## Architecture Decision Records

ADRs record decisions that affect kernel authority, protocol behavior, security boundaries, compatibility, or release policy. Accepted and superseded ADRs remain in the repository because they explain why the current design exists.

| ADR | Decision | Status |
|---|---|---|
| [0001](./adr/0001-evidence-native-dual-loop.md) | Evidence-native dual-loop runtime | Accepted |
| [0002](./adr/0002-kernel-is-sole-state-authority.md) | Kernel as sole state authority | Accepted |
| [0003](./adr/0003-event-sourced-task-ledger.md) | Event-sourced task ledger | Accepted |
| [0004](./adr/0004-typescript-zero-runtime-dependencies.md) | TypeScript with zero runtime dependencies | Accepted |
| [0005](./adr/0005-local-first-storage-layout.md) | Local-first storage layout | Accepted |
| [0006](./adr/0006-engineering-scenario-pack-extraction.md) | Engineering policy in an injected scenario pack | Accepted |
| [0007](./adr/0007-scoped-git-commit-lifecycle.md) | Scoped Git commit lifecycle | Accepted |
| [0008](./adr/0008-desktop-shell-and-contract-confirmation.md) | Desktop shell and contract confirmation | Accepted |
| [0009](./adr/0009-governed-local-mcp-and-skills.md) | Governed local MCP and Skills | Accepted |
| [0010](./adr/0010-native-model-capability-negotiation.md) | Native model capability negotiation | Accepted |
| [0011](./adr/0011-acp-mapping-and-adapter-blocker.md) | ACP mapping limitations | Proposed, blocked |
| [0012](./adr/0012-release-candidate-boundary.md) | Release-candidate boundary | Accepted |
| [0013](./adr/0013-risk-graded-startup-and-dirty-overlap.md) | Risk-graded startup and dirty-overlap refusal | Accepted |

## Project Documents

- [Roadmap](../ROADMAP.md)
- [Changelog](../CHANGELOG.md)
- [Contributing guide](../CONTRIBUTING.md)
- [Governance](../GOVERNANCE.md)
- [Security policy](../SECURITY.md)
- [Support](../SUPPORT.md)

## Maintenance Policy

- Current architecture and user-facing documentation use stable filenames and are updated with the implementation.
- Performance reports and release notes are dated because they describe a specific measurement or version.
- ADRs are append-only historical records. A later decision marks an ADR as superseded rather than deleting it.
- Temporary plans, internal product material, and generated reports are not part of the public documentation set.
