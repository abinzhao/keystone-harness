# Security Policy

Keystone executes tools against local projects, so security boundaries are part of the runtime contract. A high task-success rate does not compensate for a permission, provenance, or evidence-integrity failure.

## Supported Versions

| Version | Status | Security maintenance |
|---|---|---|
| `main` | Active development | Best-effort source fixes |
| `1.0.0-rc.1` source tree | Current release candidate; no published binary | Best-effort source fixes |
| Stable release | Not yet available | Policy will be declared with the release |

No signed or notarized binary is currently distributed.

## Reporting a Vulnerability

Private vulnerability reporting is not yet configured for this repository. Do not put exploit details, credentials, private source, or personal data in a public issue.

Until a private channel is enabled:

1. Open a minimal [security-channel request](https://github.com/abinzhao/keystone-harness/issues/new?labels=security&title=Request%20a%20private%20security%20reporting%20channel) that contains no vulnerability details.
2. State only that you need a private reporting channel and how a maintainer can reach you through your GitHub profile.
3. Wait for a maintainer to arrange a private channel before sharing technical details.

The absence of a configured private channel is a known release-readiness gap. Maintainers must enable and document private vulnerability reporting before a stable release.

## Security Boundaries

### Authority

- Model output, repository content, tool descriptions, web content, issues, and command output are untrusted inputs.
- Only kernel events change authoritative task state.
- Models and extensions cannot widen scope, issue leases, accept evidence, or mark a task complete.
- Extensions may add restrictions or confirmation requirements, but cannot add their own allow rules.

### Side Effects

- Filesystem, command, Git, credential, and network operations require a scoped Capability Lease.
- Lease validation covers the subject, capability, resource, parameters, budget, and validity period.
- Out-of-scope operations are denied before reaching the side-effect boundary.
- High-impact external writes such as payments, email delivery, and production deployment are outside the current release scope.

### Provenance and Evidence

- Context, summaries, caches, model output, tool output, evidence, and experience retain provenance and trust metadata.
- Reusing or summarising untrusted input does not raise its trust level.
- A task reaches `proven` only through the proof graph; a model's completion claim is not evidence.
- Workspace, contract, producer, or dependency changes invalidate affected evidence.

### Credentials and Data Egress

- Long-term credentials are not included in model context, logs, evidence, or proof exports.
- Credential configuration uses handles; secrets are read from stdin and stored separately with owner-readable permissions where the platform supports them.
- Cloud model requests are constrained to the configured endpoint host.
- Local runtime data is stored under `~/.keystone/` by default and can be redirected with `KEYSTONE_HOME`.
- "Local-first" does not mean "offline": configuring a cloud model permits data to leave the machine through that model endpoint.

### Command Execution

Commands are represented as an executable plus an argument array. POSIX execution does not use a shell.

Windows package-manager launchers are `.cmd` shims and require `cmd.exe`. `@keystone/spawn` limits this path to known launchers or explicit batch files and escapes arguments before invocation. Native executables continue to launch directly.

On POSIX, timeouts terminate the process group. Windows currently terminates only the direct child; this is a documented limitation.

### Desktop Preview

The macOS preview window loads a supervised loopback proxy:

- the webview does not receive the Run Protocol bearer token;
- the proxy injects the token upstream;
- private desktop routes require a per-start nonce;
- closing the window tears down the proxy and runtime child.

This is not a hardened multi-user boundary. A process running as the same operating-system user may inspect user-owned process state and files. The preview is not signed, notarized, sandboxed, or distributed as an application bundle.

### Extensions and Supply Chain

Extensions declare identity, version, integrity, capabilities, schemas, data handling, dependencies, replay properties, and uninstall behavior. Installation validates the entry bytes, runs conformance checks, and presents risk before activation.

An extension update does not automatically inherit the previous version's trust. Project-local Skills and MCP servers are untrusted until reviewed and activated; their location alone grants no permission.

## In Scope

Examples include:

- a path or command escaping a valid lease;
- unauthorized network or credential access;
- a way for model or extension output to change authoritative state;
- evidence accepted for the wrong task, contract, producer, or workspace;
- ledger, proof, or replay integrity failures;
- a desktop token or nonce bypass;
- extension integrity or activation bypasses.

Model answer quality, expected behavior inside an explicitly granted capability, and known absence of packaging/signing are not vulnerabilities by themselves.

## Related Documents

- [Architecture overview](./docs/architecture/overview.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Governance](./GOVERNANCE.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
