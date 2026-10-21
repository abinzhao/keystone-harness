# Governance

Keystone is currently maintainer-led. Maintainers are responsible for the project direction, release decisions, security posture, and interpretation of the kernel invariants.

The model is intentionally simple while the project is in release-candidate development. Governance changes are made in public through pull requests and, when they affect durable project policy, an Architecture Decision Record (ADR).

## Roles

| Role | Responsibilities | Appointment |
|---|---|---|
| Contributor | Reports issues and submits code, tests, documentation, extensions, or evaluation cases | Any participant with an accepted contribution |
| Committer | Reviews and merges changes within an assigned package or domain; maintains its tests and compatibility | Appointed by maintainers after sustained, trusted contributions |
| Maintainer | Sets direction, manages releases and security, approves architectural changes, and interprets invariants | Appointed by the existing maintainers |

Authority is scoped. A committer's merge authority applies only to their assigned area. Changes to the kernel, schemas, protocol, security model, or release policy require maintainer review.

## Decisions

Routine fixes and documentation changes use the normal pull-request process.

An ADR is required for changes to:

- kernel authority or state transitions;
- Contract, Capability Lease, Provenance, Evidence, or Proof semantics;
- schema or protocol compatibility;
- extension lifecycle or privilege boundaries;
- credential, network, or data-egress policy;
- stable interfaces in a breaking way.

The ADR author describes the context, options, decision, compatibility impact, migration, and rollback. Accepted ADRs remain in the repository. A later decision marks an earlier ADR as superseded rather than rewriting history.

Maintainers seek consensus for architectural and governance decisions. When consensus is not possible, the lead maintainer records the final decision and reasoning in the relevant pull request or ADR.

## Versioning and Compatibility

| Surface | Policy |
|---|---|
| Kernel | Semantic versioning; invariant changes require an ADR |
| Keystone Run Protocol | Semantic versioning and startup capability negotiation |
| Schemas | Independently versioned; generated from the runtime validators |
| Extension SDK and Conformance Kit | Semantic versioning with explicit deprecation |

An incompatible change requires:

1. an accepted ADR;
2. a major version change for the affected surface;
3. migration guidance;
4. read or export support for retained data where migration is not possible.

Silent semantic loss is not compatibility. A client or adapter that cannot represent a required protocol object must reject or explicitly degrade the operation.

## Becoming a Maintainer

Maintainer appointments consider:

- sustained, constructive participation;
- sound review judgment;
- demonstrated understanding of the trust boundaries;
- reliable handling of compatibility and security concerns;
- willingness to maintain work after merge.

There is no contribution-count threshold. Appointments and changes in responsibility are announced in the repository.

## Related Documents

- [Contributing guide](./CONTRIBUTING.md)
- [Architecture overview](./docs/architecture/overview.md)
- [ADR index](./docs/README.md#architecture-decision-records)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Roadmap](./ROADMAP.md)
