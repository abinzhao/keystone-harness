# Contributing to Keystone

Keystone accepts focused fixes, tests, documentation, evaluation cases, and extensions. The project is still a release candidate, so compatibility and trust-boundary changes receive stricter review than ordinary implementation changes.

Before contributing, read the [architecture overview](./docs/architecture/overview.md), [Code of Conduct](./CODE_OF_CONDUCT.md), and [security policy](./SECURITY.md).

## Development Setup

Requirements:

- Node.js `>=22.18.0`
- pnpm `8.15.9`
- Git

Install and verify the workspace:

```bash
pnpm install
pnpm run verify
pnpm run release:check
```

The repository runs TypeScript directly with Node native type stripping. There is no transpilation or application build step.

Useful commands:

```bash
pnpm run typecheck       # TypeScript validation
pnpm test                # node:test suite
pnpm run bench           # local performance baseline
pnpm run release:all     # local release check, SBOM, and build information
```

Release commands generate local files under `dist/`. They do not publish, tag, sign, notarize, commit, or push.

## Architecture Rules

The following rules protect the runtime's trust boundary:

1. Models and extensions propose actions; they do not change authoritative state, issue permissions, accept evidence, or decide completion.
2. Every authoritative state change goes through `KernelSession` and an append-only kernel event.
3. Every side effect passes through the execution boundary with a valid Capability Lease.
4. Provenance, trust, and invalidation metadata remain attached when context or evidence is transformed.
5. Extensions may add restrictions but cannot grant authority or replace kernel completion logic.

Package dependencies point toward lower layers:

```text
cli -> runtime -> {kernel, models, tools, verifiers, extensions, pack-engineering}
kernel -> schemas
tools/verifiers -> kernel, schemas, spawn
pack-engineering -> kernel, schemas
```

`@keystone/kernel` must not import execution packages or scenario packs. Scenario-specific contract and capability policy is injected by the runtime.

## Code Conventions

- Use TypeScript supported by Node native type stripping.
- Do not use `enum`, `namespace`, decorators, or constructor parameter properties.
- Include the `.ts` extension in relative imports.
- Keep production runtime dependencies at zero.
- Use the runtime validators as the single source for inferred TypeScript types and generated JSON Schema.
- Follow existing naming, error handling, and test patterns.
- Keep changes scoped; do not mix unrelated formatting or refactoring.
- Explain boundaries and non-obvious reasons in comments. Do not narrate the code.
- Do not edit generated files, third-party code, build output, or the lockfile by hand.

## Tests

Add the smallest test that proves the changed behavior. Changes to state, permissions, evidence, recovery, or completion must cover the relevant invariant and a refusal or invalidation path where applicable.

Run the focused test first, then the full gate:

```bash
node --test packages/<package>/test/<file>.test.ts
pnpm run verify
```

Do not make a failing implementation pass by deleting tests, weakening assertions, swallowing errors, or replacing meaningful integration with an unrepresentative mock.

## Architecture and Compatibility Changes

Open an ADR before changing any of the following:

- kernel invariants or state transitions;
- Contract, Lease, Provenance, Evidence, or Proof semantics;
- schema or protocol compatibility;
- extension installation, activation, isolation, or authority;
- security or credential boundaries;
- a stable interface in a breaking way.

ADRs live under `docs/adr/NNNN-*.md` and describe context, options, decision, invariant impact, compatibility, migration, and rollback. Breaking changes also require a major version and migration guidance.

## Pull Requests

1. Create a focused branch from the current `main`.
2. Keep each commit limited to one reviewable purpose.
3. Use [Conventional Commits](https://www.conventionalcommits.org/).
4. Sign commits with the [Developer Certificate of Origin](https://developercertificate.org/) using `git commit -s`.
5. Complete the pull-request template, including verification results and unverified risks.
6. Ensure CI is green before requesting review.

Commit example:

```text
fix(kernel): reject expired capability leases

Explain why the change is needed and how the invariant is preserved.

Signed-off-by: Your Name <name@domain.invalid>
```

Documentation-only changes do not need artificial code tests, but they must pass link checks, `git diff --check`, and any repository checks affected by changed commands or package metadata.

## Reporting Problems

- Use a [GitHub issue](https://github.com/abinzhao/keystone-harness/issues) for reproducible defects, scoped feature proposals, or documentation corrections.
- Do not include vulnerability details or sensitive conduct reports in public issues. The current private-reporting limitations are documented in [SECURITY.md](./SECURITY.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
