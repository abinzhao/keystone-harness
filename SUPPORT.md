# Support (SUPPORT)

This document describes where to ask questions, report defects, and suggest features, as well as what is out of scope for support. Before asking, please first **check the documentation and existing Issues** to avoid duplicates.

## 1. Do These Three Things First

1. Read [`README.md`](./README.md) and [`需求文档.md`](./需求文档.md) (the authoritative basis for the product).
2. Search existing Issues and Discussions to confirm the problem/suggestion has not already been raised.
3. If it involves a security vulnerability, **do not use public channels**; disclose privately per [`SECURITY.md`](./SECURITY.md).

## 2. Question Triage

| Your need | Suggested channel |
|---|---|
| Defect report (Bug) | Submit an Issue with reproduction steps, expected vs. actual, and environment information |
| Feature suggestion / requirement discussion | Use Discussions, or submit an Issue labeled `enhancement` |
| Usage, design, and architecture questions | Use Discussions (Q&A) |
| Contribution interest and development process questions | Read [`CONTRIBUTING.md`](./CONTRIBUTING.md); if still in doubt, ask in Discussions |
| Documentation errors or lack of clarity | Submit an Issue (labeled `docs`) or open a PR directly |
| Code of Conduct-related complaints | Report privately per [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) |
| Security vulnerabilities | Disclose privately per [`SECURITY.md`](./SECURITY.md); **public disclosure is prohibited** |

> At this stage the project is in the **product and architecture design phase and has not yet shipped a production runtime**. Defect reports are therefore mostly concentrated on design documents, evaluation cases, and conformance tests; actual runtime usage issues will appear as milestones progress.

## 3. Minimum Information When Submitting a Defect

- What you expected to happen and what actually happened;
- Minimal reproduction steps (commands, inputs, repository state);
- Version/commit hash, platform (macOS for the initial release), model, and configuration category (**do not include real credentials or sensitive data**);
- Relevant logs or proof references (if applicable, with sensitive data redacted).

## 4. Out of Scope for Support

The following are **not** within the scope of community support:

- Private deployments, hosted services, and commercial support (this project is an open-source project and does not promise a commercial SLA);
- Custom adaptation, migration, or data recovery for your specific project;
- General day-to-day office/non-engineering Agent usage (outside this product's scope, PRD 4.4);
- Capabilities explicitly excluded from the initial release (such as mobile, an enterprise web admin console, automatic payments/email/production deployment, and non-isolated plugin or Skill marketplaces, PRD 4.4);
- Any guarantee of the model's own answer quality (the model is replaceable; the completion standard is independent of the model, PRD 15).

## 5. Support Commitments and Timeframes

- Community support is **best-effort**, provided voluntarily by maintainers and contributors, with no SLA commitment.
- Response timeframes for security issues are described in [`SECURITY.md`](./SECURITY.md).
- The overall response and fix cadence aligns with the milestones in [`ROADMAP.md`](./ROADMAP.md).

## 6. Related Documents

- Roadmap: [`ROADMAP.md`](./ROADMAP.md)
- Contribution guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Governance model: [`GOVERNANCE.md`](./GOVERNANCE.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
