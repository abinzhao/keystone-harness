# Governance Model (GOVERNANCE)

This document describes Keystone's decision-making mechanisms, role responsibilities, versioning and compatibility strategy, and the Architecture Decision Record (ADR) process. The project is currently in the **design phase**, and governance will evolve gradually as the community matures.

## 1. Current Governance Model: Maintainer-Led

Keystone currently adopts a progressive governance model of **maintainer leadership (BDFL → Maintainer Committee)**:

- **Phase One (current): BDFL.** The project founder serves as Benevolent Dictator for Life (BDFL), holding decision-making authority over architectural direction and final merges, and being responsible for the project vision and kernel invariants.
- **Phase Two: Maintainer Committee.** Once the project reaches stable releases and multiple long-term, stable core contributors emerge, the BDFL and existing maintainers jointly establish a Maintainer Committee, in which major decisions are reached by consensus through deliberation; the BDFL retains final adjudication authority when consensus cannot be reached.
- **Transition triggers** (satisfaction initiates discussion): core maintainers remain continuously active for ≥ 6 months; there are 2 or more maintainers able to independently review kernel/Schema/protocol changes.

**Evolution principle**: governance changes themselves also go through an ADR; any governance adjustment must keep the kernel invariants stable and publicly transparent.

## 2. Roles and Responsibilities

| Role | Responsibilities | How granted |
|---|---|---|
| Contributor | Submit code, documentation, evaluation cases, extensions, or feedback; comply with [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | Anyone who submits a valid contribution is a contributor |
| Committer | Holds review and merge authority in a specific domain (package/extension point); maintains the corresponding tests and gates; mentors contributors | Nominated and approved by existing Maintainers |
| Maintainer | Responsible for the project's overall direction, releases, security, and governance; holds final authority to interpret kernel invariants; participates in ADR decisions | Approved by the BDFL/Maintainer Committee |

Authority follows the principle of least privilege: a Committer's merge authority is limited to their domain of responsibility; changes touching the kernel, Schema, protocol, or security semantics must be reviewed by a Maintainer.

## 3. Decision-Making Mechanisms

- **Routine changes**: go through regular PR review and are merged by the Committer/Maintainer for the corresponding domain (see [`CONTRIBUTING.md`](./CONTRIBUTING.md)).
- **Architectural decisions**: recorded as an **ADR (Architecture Decision Record)**; any decision affecting kernel invariants, contract semantics, Lease, provenance propagation, completion determination, extension lifecycle, or protocol compatibility must be backed by an ADR (see Section 5).
- **Major breaking changes**: follow the **major version + migration guide** path (PRD 18.3):
  - The kernel, protocol, Schema, and SDK each adopt **semantic versioning**;
  - Breaking changes are released through an ADR, a migration guide, and a major version;
  - Stable versions maintain read or export capability for at least the current and previous major data formats;
  - Deprecations must clearly specify the replacement, the last supported version, and the removal conditions.
- **Security decisions**: security-related decisions take priority over feature progress; a high task completion rate cannot substitute for a security determination ([`SECURITY.md`](./SECURITY.md)).
- **Consensus first**: within the committee, consensus through deliberation is preferred; when consensus cannot be reached, the BDFL adjudicates and records the reasoning.

## 4. Versioning and Compatibility Strategy

Based on PRD 18.3 and NFR-COMP-01~05:

| Unit | Versioning approach | Compatibility commitment |
|---|---|---|
| Kernel | Semantic versioning | Kernel invariants are stable; breaking changes follow the major version + migration guide path |
| Protocol (Keystone Run Protocol) | Semantic versioning | Client and Runtime negotiate protocol and capabilities at startup; semantics that cannot be expressed are explicitly degraded or rejected, and silent loss is prohibited |
| Schema (Contract / Run Event / Lease / Evidence / Proof / Extension Manifest) | Independently semantically versioned each | New Runtimes within the support window can read old data; read-only export is provided when migration is not possible |
| SDK (Extension SDK / Conformance Kit) | Semantic versioning | Provides a compatibility matrix, deprecation cycle, and Conformance Kit |

Generated files are produced from the authoritative Schema, and multiple inconsistent definitions are not maintained by hand (PRD 12.5 NFR-COMP-05, 18.3).

## 5. ADR Process and Directory Convention

- **Directory convention**: `docs/adr/NNNN-*.md`, where `NNNN` is a four-digit incrementing number (for example `docs/adr/0001-evidence-native-dual-loop.md`).
- **When an ADR is required**: changes to kernel invariants, the state machine, permission issuance, evidence integrity, completion determination, provenance propagation, extension lifecycle, protocol/Schema semantics, or any breaking change.
- **Process**:
  1. Draft the ADR (status `Proposed`), describing the context, problem, options, decision, impact on kernel invariants and compatibility, and migration and rollback approach;
  2. Discuss openly in the PR and have it reviewed by a Committer/Maintainer;
  3. Once consensus is reached, set it to `Accepted` and merge it;
  4. If superseded by a later decision, set it to `Superseded by ADR-XXXX`, retain the original record, and do not delete history (a revision must not delete historical versions or alter the record of historical decisions, PRD 8.2 OT-03).
- **Relationship with code**: ADRs involving kernel/Schema/protocol behavior must be accepted before the corresponding code changes are merged; undocumented invariant changes must not be merged (see [`AGENTS.md`](./AGENTS.md) §6).

## 6. Relationship with Other Documents

- Contribution process: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
- Support channels: [`SUPPORT.md`](./SUPPORT.md)
- Roadmap: [`ROADMAP.md`](./ROADMAP.md)
- Product requirements: [`需求文档.md`](./需求文档.md)
