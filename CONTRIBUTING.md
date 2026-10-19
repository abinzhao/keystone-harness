# Contributing Guide (CONTRIBUTING)

Thank you for your willingness to contribute to Keystone. Keystone is an evidence-native, local-first engineering Agent Harness. Before you begin, please read this document, [`AGENTS.md`](./AGENTS.md) (kernel invariants and code conventions), [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md), and [`SECURITY.md`](./SECURITY.md).

> The project is currently in the **product and architecture design phase** and has not yet released a production runtime. Some processes (such as initial-release acceptance and the release scorecard) will be implemented progressively as milestones advance (see [`ROADMAP.md`](./ROADMAP.md)).

## 1. Development Environment Requirements

| Item | Requirement |
|---|---|
| Node.js | `>= 22.18` (uses Node native type stripping and `node:test`) |
| Package manager | `pnpm` 8 |
| Platform | Initial support for macOS; local Git repository |
| Language | TypeScript, zero runtime dependencies |

No build-time transpilation dependencies are introduced: code is run and tested using Node native type stripping.

## 2. Local Commands

```bash
# Install dependencies
pnpm install

# Type check (produces no build artifacts)
pnpm run typecheck

# Run tests (node:test)
pnpm test
```

> If the above scripts are not yet defined before the corresponding milestone lands, defer to the actual script names in the repository-root `package.json` and update this document accordingly in the PR.

## 3. Extension Points That Can Be Contributed Independently

Contributors **do not need to understand the entire kernel** in order to contribute independently. The following extension points come from PRD 18.2; each type of contribution has a minimal interface, examples, test fixtures, and a conformance gate.

| Extension point | Minimal interface | Conformance gate |
|---|---|---|
| Model adapter | Implement a stable interface for model invocation, declaring purpose, capabilities, and data egress scope; does not touch task state or long-term credentials | Pass the model interface conformance tests; must not read or write authoritative state; must not hold long-term credentials |
| Tool and MCP adapter | Declare required capabilities, resources, side effects, network access, and credentials; all side effects are executed through a Capability Lease | Pass the tool interface conformance tests; verify that side effects are reachable only within the Lease scope |
| Project Analyzer | Produce Project Facts with provenance, applicable snapshot, trust level, and invalidation conditions | Pass the analyzer conformance tests; outputs must be traceable to their provenance and invalidation conditions |
| Workspace Runtime | Implement the workspace snapshot, isolation, and lifecycle interfaces; support checkpoints and state replay | Pass the workspace conformance tests; authoritative state must be consistent after replay |
| Verifier | Declare the Evidence types it can produce, evidence level, independence, and invalidation conditions; does not modify completion decisions | Pass the verifier conformance tests; must not create or relax completion conditions; must not modify evidence results |
| Agent Skill | Integrate as a reusable capability package; its content is treated as untrusted input | Pass the Skill conformance tests; does not automatically gain project permissions by virtue of its installation source |
| Protocol adapter (ACP / A2A / other) | Declare capability negotiation and semantic mapping; semantics that cannot be expressed must be explicitly degraded or rejected | Pass the protocol conformance tests; must not change Contract, Lease, Provenance, Evidence, or completion semantics; silently dropping semantics is forbidden |
| Evaluation tasks, fault injection, and security cases | Follow the public evaluation task format, runner, and metric definitions (PRD 18.1, 13.2) | Reproducible; cover the specified scenarios; security cases cover the six phases of configuration, extension, execution, persistence, action, and recovery |

**Common gate**: every extension must declare an Extension Manifest (name, version, publisher, integrity, required capabilities, input/output Schema, data classification, producible Observation/Evidence types, replayability, idempotency, dependencies, and uninstall behavior), and may be activated only after passing integrity checks, dependency resolution, conformance tests, risk disclosure, and user confirmation (PRD 8.11 PL-01/PL-02, 9.7).

## 4. Commit Message Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[body: why this change is made]

Signed-off-by: Your Name <you@example.com>
```

Common `type` values: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
For `scope`, prefer the affected package or domain, for example `kernel`, `schemas`, `runtime`, `verifiers`, `cli`, `docs`.

- A single commit focuses on one thing and is traceable to a requirement or completion criterion.
- Mark breaking changes explicitly in the commit body with `BREAKING CHANGE:`, and follow ADR + major version + migration guide (PRD 18.3).
- Do not mix in unrelated formatting or refactoring.

## 5. DCO and CLA

- This project uses the **DCO (Developer Certificate of Origin)**: add a `Signed-off-by` line to each commit via `git commit -s`, certifying that you have the right to submit the content and agreeing to the DCO (https://developercertificate.org/).
- **CLA note**: To keep licensing and governance clear, the project uses Apache-2.0 and requires contributions to be signed off via DCO. If a formal CLA is introduced in the future, it will be described in a separate document and announcement, and its applicability to existing DCO contributions will be made explicit. **Until a CLA is in place, DCO is the effective means of signing off.**

## 6. Branch and PR Workflow

1. Branch a feature branch off the latest main branch; suggested naming: `feat/<short-description>`, `fix/<short-description>`, `docs/<short-description>`.
2. Keep the workspace clean; do not overwrite, revert, or reformat others' changes.
3. Pass type checking and tests locally before committing.
4. Open a PR; the PR description must include:
   - The purpose of the change and the requirement/completion criterion it traces to;
   - The impact scope (which packages are involved, and whether kernel invariants, Schema, or protocol are touched);
   - How it was verified and the results (commands and conclusions);
   - Unverified items and remaining risks.
5. Changes involving the kernel, Schema, protocol, or security semantics must be linked to the corresponding ADR or documentation update.
6. Enter review after passing CI (type checking, tests, conformance).

## 7. Code Review Requirements

- Merge only after approval by at least one maintainer/committer (for governance roles, see [`GOVERNANCE.md`](./GOVERNANCE.md)).
- Review focus: whether kernel invariants are correctly maintained; whether package boundaries and code conventions are followed (`enum`/`namespace`/parameter properties forbidden, relative imports include `.ts`); whether reproducible verification evidence is included; whether unrelated changes are introduced.
- Security-related changes must also satisfy the control requirements in [`SECURITY.md`](./SECURITY.md); a high task completion rate cannot substitute for a security determination.
- Review comments are based on technical facts; for disagreements, an ADR discussion may be requested.

## 8. Code of Conduct

By participating in this project you agree to abide by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). If you experience inappropriate behavior, report it as described in that document.
