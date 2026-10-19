# Security Policy and Threat Model (SECURITY)

Keystone is an evidence-native, local-first engineering Agent Harness. It understands projects on the local machine, executes engineering tasks with side effects, and judges completion using replayable evidence. Security is therefore not an add-on but a core invariant of the product: **a high task completion rate cannot substitute for a security determination** (PRD 11.6).

This document describes the supported versions, the vulnerability disclosure process, and Keystone's threat model and security controls. The product basis for the threat model is [`需求文档.md`](./需求文档.md) Section 11 (Security, Privacy, and Data Boundaries) and Section 13 (Success Metrics).

> The project is currently in the **design phase and has not yet shipped a production runtime**. The supported-version table and response timeframes are provisional commitments that will be calibrated to the actual release cadence when the first stable version is released.

## 1. Supported Versions

| Version | Status | Security Updates |
|---|---|---|
| `main` (design phase) | In development, no released version | No binary support; security feedback at the documentation and design level is accepted |
| First stable version (unreleased) | Planned | Security updates provided after release, with the window declared in the release notes |
| Stable versions N and N-1 | Planned | At minimum, maintain read or export capability for the current and previous major data formats (PRD 18.3) |

When a stable version is released, it must provide: reproducible build information, a dependency and software bill of materials (SBOM), signed installers, and macOS notarization results (PRD 18.4).

## 2. Private Disclosure Channel

**Do not disclose security vulnerabilities through public Issues, Pull Requests, Discussions, or social media.**

Please report through the following private channels:

- Email: `security@example.com` (**placeholder value, to be replaced with a real security mailbox before release**)
- Backup channel: `security@example.com` (**placeholder value, to be replaced before release**)

> ⚠️ All of the above are obvious placeholders. Before formally accepting external security reports, the project must replace them with a usable private disclosure channel (such as a dedicated security mailbox or a private report form) and update this section accordingly.

Reports should include as much of the following as possible: affected version/commit, reproduction steps, impact scope, possible attack paths, and (if applicable) suggested mitigations. Do not make details public before a patch is released.

## 3. Response Timeframe Commitments

The following are **target** response timeframes (business days), to be calibrated as the project matures:

| Stage | Target timeframe |
|---|---|
| Acknowledge receipt of report | Within 3 business days |
| Initial assessment and severity classification | Within 7 business days |
| Fix or mitigation plan and schedule | Provide a plan within 30 business days for severe issues |
| Fix release and acknowledgment (with reporter's consent) | Follow the assessment plan |

We respect the reporter's privacy; we will not disclose their identity without consent. Whether to publicly acknowledge is at the reporter's discretion.

## 4. Threat Model Overview

Keystone's core trust stance (PRD 2, 11):

- The model can only propose actions and candidate experience; it **must not unilaterally relax goals, expand permissions, or declare completion**.
- Only kernel events can change authoritative state; all side effects must go through a Capability Lease.
- Provenance and trust levels must propagate across summaries, caches, memory, Skills, sub-Agents, shared artifacts, and Proof; untrusted content must not be "laundered" through reuse.
- File writes, commands, network access, credentials, and external system operations that are not explicitly permitted within the current task scope are **denied by default** (PRD 11.1).

### 4.1 Harness Lifecycle Security (PRD 11.6)

Security requirements cover the following six stages; the required controls for each stage are as follows:

| Stage | Required controls |
|---|---|
| Configuration | Configuration sources, sensitive fields, degradation options, and policy changes are auditable |
| Capability Extension | Integrity, publisher, Manifest, dependencies, permissions, and conformance testing |
| Execution | Prompt Injection, tool poisoning, path escape, and data egress controls |
| State Persistence | Provenance propagation, candidate isolation, memory poisoning, and cross-session trigger protection |
| Action Control | Capability Lease, idempotency, reversibility, human confirmation, and receipts |
| Incident Recovery | Contamination tracking, state repair, credential revocation, evidence retention, and trusted recovery |

Security evaluation must check four dimensions simultaneously: **task utility, attack success, contamination persistence, and detection and recovery integrity** (PRD 11.6, 13.2).

### 4.2 Tools and Content Are Untrusted (PRD 11.2)

Trust model: tool descriptions, repository content, web content, Issue text, and command output **may all contain malicious instructions**.

- Such content **does not constitute** authorization to modify task goals, permissions, or completion conditions.
- Untrusted state must propagate across summaries, caches, long-term memory, Skills, sub-Agents, shared artifacts, and Proof.
- When a subsequent benign task references contaminated content, the system still judges by the **original provenance**, and does not "launder" the provenance just because it is reused across sessions.
- Skills and MCP content are treated as untrusted capability inputs and do not automatically gain project permissions by virtue of their installation source (PRD 9.7).

### 4.3 Credential Protection (PRD 11.3)

- Long-term credentials are **not shown to the model**.
- Task execution only obtains short-term capabilities matching the current action.
- The Shell does not directly hold long-term credentials.
- A Capability Lease contains only the short-term handles, resource scope, and validity period required for the current action.
- Extensions can only access credentials declared in the Manifest and approved by the user.
- Credentials **must not** enter the model context, logs, Evidence, or export packages.

### 4.4 Data Sovereignty and Egress (PRD 11.4)

- Project understanding, task state, run graphs, caches, and evidence are stored locally by default.
- When using a cloud model, the system sends only the content explicitly listed in the current Context Plan.
- Before sending, it displays the model provider, the scope of data sent this time, source types, sensitivity levels, and estimated Tokens.
- It supports a fully offline mode using local models.
- The local mode, cloud model mode, and remote Workspace mode must be clearly distinguished, and **"local-first" must not be used to conceal actual egress behavior**.

### 4.5 Extensions and Supply Chain (PRD 11.7)

- An extension's installation source, version, hash, and publisher information must be viewable.
- An extension update **does not automatically inherit** all the trust and Autonomy Credit of the previous version.
- Configuration, Hooks, Skills, and plugin declarations in a project repository must not expand capabilities before the user trusts the workspace.
- Extensions may add denial and confirmation rules, but **must not unilaterally add Allow rules or disable security modes**.
- Upon discovering a malicious or incompatible extension, the system supports isolation, rollback, impact analysis, and cleanup of derived state.

### 4.6 High-Risk External Actions (PRD 11.5)

The initial release **does not perform** payments, email sending, production deployments, and other external write operations that are difficult to undo. When supported in the future, these must have idempotency identifiers, before-and-after state, server-side receipts, and compensation paths.

### 4.7 Platform Execution Boundary (PRD 11.1, EX-02)

Command execution is one of the highest-risk surfaces, so it has one deliberate
rule: an executable name and its arguments arrive **separately** and are handed
to `spawn` with no shell, so a value that came from a repository or a model can
never turn into a pipeline, redirection or second command (PRD EX-02).

On Windows the package-manager launchers (`npm`, `pnpm`, `yarn`, `npx`) are
`.cmd` shims rather than executables. Since Node 18.20 / 20.12 / 21.7
(CVE-2024-27980) such a shim cannot be spawned directly, so — and only for these
launchers — they are run through `cmd.exe`. That is the one place a shell
re-enters the model, and it is compensated for rather than waved through:

- The command processor is invoked explicitly with `/d /s /c`; the arguments
  are escaped for `cmd.exe` before being handed over, using the cross-spawn
  algorithm (MIT, based on https://qntm.org/cmd), and Node is told not to quote
  them a second time.
- Only a bare, known launcher name or an explicit `.cmd`/`.bat` path is wrapped;
  native executables (`node`, `git`, and real `.exe`/`.com` files) are still
  launched directly, with no shell.
- On POSIX the path is unchanged: no shell is involved at all.

A spawned process group is killed as a whole on timeout on POSIX; on Windows the
negative-pid group kill is unsupported, so only the direct child is terminated —
a known limitation, not a guarantee.

## 5. Out of Scope for Security Design

The following are not targets of security vulnerability reports and must not be submitted as vulnerabilities:

- Normal behavior within the capabilities the user has explicitly granted in the project and that complies with the Autonomy Envelope;
- Issues with the model's own output quality, hallucinations, or answer style (these should go through the feature feedback channel in [`SUPPORT.md`](./SUPPORT.md));
- The not-yet-released production runtime (no available version currently), though security review comments on the **design** are welcome.

## 6. Related Documents

- Product requirements (security sections): [`需求文档.md`](./需求文档.md) §11, §13
- Kernel invariants (security-related invariants): [`AGENTS.md`](./AGENTS.md)
- Governance and ADR: [`GOVERNANCE.md`](./GOVERNANCE.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
