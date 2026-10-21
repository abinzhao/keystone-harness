# Roadmap

This roadmap uses three levels:

- **Current**: implemented or required to finish the current release candidate.
- **Next**: accepted direction whose prerequisites are not yet complete.
- **Explore**: research without a delivery commitment.

Items move forward only when their entry and exit conditions are observable. The roadmap does not assign dates.

## Current

| Area | Status | Remaining exit condition |
|---|---|---|
| Evidence-native task loop | Implemented | Continue invariant and acceptance coverage as interfaces change |
| Local Run Protocol and web workbench | Implemented | Keep protocol/schema parity and browser verification in CI |
| Engineering scenario pack | Implemented | Remove remaining engineering-shaped types from generic seams only when another scenario proves the abstraction |
| Scoped Git writes | Implemented | Maintain lease, dirty-overlap, and rollback coverage |
| Local MCP and on-disk Skills | Implemented | Maintain manifest, integrity, conformance, and activation gates |
| Native model protocols | Mock-tested | Complete live-provider verification without weakening capability declarations |
| macOS source preview | Implemented | Produce a universal application bundle, then sign and notarize it |
| Windows support | Preview | Run the full end-to-end suite on Windows and cover process-tree termination |
| Release tooling | Implemented locally | Exercise the hosted CI paths and keep release artifacts reproducible |

The current release remains `1.0.0-rc.1`. It is a source release candidate, not a signed desktop release or an npm package.

## Next

### Reproducible Evaluation

**Entry:** a versioned task set with independent acceptance scripts.

**Exit:** repeated Minimal and Standard mode runs publish variance, failure classes, verification completion, intervention rate, context cost, out-of-scope changes, and escape rate under fixed model and environment settings.

### Multi-Project Runtime

**Entry:** the single-project loop and isolated workspace behavior remain stable under recovery tests.

**Exit:** one runtime can manage several projects while concurrent write tasks use separate worktrees and cannot change each other's state or evidence.

### Additional Project Adapters

**Entry:** unrecognized build, test, and entry points fail explicitly instead of being guessed.

**Exit:** at least one additional language or framework adapter has versioned discovery rules, precise invalidation, and end-to-end task coverage.

### Non-Interactive Integrations

**Entry:** the Run Protocol and `keystone ci` contract remain stable across a release cycle.

**Exit:** an external client can drive a run and retrieve a machine-readable proof without gaining authority outside the kernel.

ACP integration is blocked until the protocol can carry Keystone's Contract, Lease, Evidence, and Proof semantics without silent loss. ADR-0011 records the current mapping gap.

## Explore

- Remote delegation that carries provenance, lease scope, and proof across machines.
- Team sharing for signed project facts, experience, and proofs without requiring a central state authority.
- Scenario packs outside engineering, implemented through adapters and extensions without changing the kernel.
- Provider transport convergence when it reduces lock-in without weakening capability negotiation.

Exploration does not imply that these features are implemented or scheduled.

## Stable Release Gates

A stable release requires:

1. green type checking, tests, conformance, and acceptance suites on supported platforms;
2. reproducible release artifacts and a documented compatibility window;
3. a configured private security-reporting channel;
4. no known path for models or extensions to change authority, scope, evidence, or completion decisions;
5. measured evaluation results under fixed, reproducible conditions;
6. signed and notarized artifacts for any distributed macOS application.

Feature count is not a release gate. Claims about quality or performance must cite a reproducible measurement.
