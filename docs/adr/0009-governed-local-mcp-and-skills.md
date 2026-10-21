# ADR-0009: Governed local extension ecosystem — stdio MCP adapter and on-disk Agent Skills

- **Status**: Accepted (2026-10-20)
- **Date**: 2026-10-20
- **Decision basis**: local-path installation, declarative manifests, provenance propagation, default-deny leases, ADR-0002, ADR-0004, ADR-0006, and the existing extension/spawn/tool boundaries.

## Context

Keystone already governs *in-process* extensions: a local package ships a `keystone-extension.json` manifest, its entry digest is checked, the Conformance Kit runs, and the registry gates activation. Two whole classes of local, untrusted code are not yet reachable through that same authority:

1. **Out-of-process tools** that speak the Model Context Protocol (MCP) over `stdio` — an external command Keystone launches, performs a JSON-RPC handshake with, and exposes as tools.
2. **Agent Skills** discovered as on-disk directories (`SKILL.md` + declared `resources/` / `scripts/`) under a project or a user skills root — progressive-disclosure knowledge/playbooks the model may load, but that must never become authority by merely being present.

The hard constraints (repo invariants 1–5) are unchanged: the model proposes, the kernel constrains, evidence decides. Neither the MCP child nor a Skill gets a capability by existing; both are untrusted input; there is no remote transport and no marketplace. Both must be installed/disclosed through the **existing** `keystone extension` CLI and `ExtensionRegistry` — not a second authority.

## Decisions

### Decision A — An MCP server is a `kind: "protocol"` extension installed through the existing local-path flow

A stdio MCP server is a local package directory whose `keystone-extension.json` has `kind: "protocol"` and a new optional `transport.stdio` block:

```jsonc
{
  "kind": "protocol",
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["servers/my-mcp/build/index.js"],
    "cwd": "."            // optional; resolved against the package root
    // "env": { "MY_FLAG": "1" }  // optional extras, filtered like every other env
  }
}
```

There is no separate MCP registry, no `keystone mcp add`, and no download. `keystone extension inspect|install <dir>` already reads the manifest, checks integrity, runs conformance and discloses risks; the MCP adapter is just another *host* the conformance kit can probe. The registry remains the only writer of extension state.

**Schema compatibility.** `keystone.extension.manifest` moves `1.0.0 → 1.1.0`. The change is **purely additive**: a new optional `transport` block, and `entry` becomes optional (protocol/skill extensions load no in-process TS module). Every 1.0.0 manifest still parses unchanged; old registries reading a 1.1.0 manifest see only an extra optional field they ignore. No field is renamed or made required-then-removed, so this is a minor bump, not a breaking one.

### Decision B — The child is launched only through the neutral spawn boundary

The adapter never calls `child_process.spawn` directly with a shell. It resolves the target through `@keystone/spawn`'s `resolveSpawnTarget` (Windows `.cmd`/`.bat` handling + `cmd.exe` argument escaping) and builds the environment with `sanitizeEnv`: an allowlisted plumbing set, with every credential-shaped variable stripped, then the manifest's declared `env` extras filtered through the same secret filter. A manifest therefore cannot smuggle `$GITHUB_TOKEN` into the child, and the child cannot be turned into a second shell by argument injection (argv stays an array).

The manifest declares `command` as a *bare name or absolute path*; relative server scripts are resolved against the package root and confined there.

### Decision C — Everything the child says is `untrusted` provenance

The wire is newline-delimited JSON-RPC 2.0 over the child's `stdin`/`stdout` (the child's `stderr` is captured as diagnostic, never forwarded as tool content). Handshake is fixed and ordered:

1. send `initialize` `{protocolVersion, capabilities:{}, clientInfo}`,
2. await the server's `initialize` result,
3. send the `notifications/initialized` notification,
4. call `tools/list`.

The server's `serverInfo`, tool names, descriptions, `inputSchema` and every `tools/call` result are recorded as `sourceKind: "extension"`, `trustLevel: "untrusted"`. Per invariant 4 and `effectiveTrust`, these can be read and reasoned about but can **never** become a lease, a completion condition, policy, or long-term experience. A child that emits a fake `lease`/`decision`/`proof` field is ignored, not acted on.

### Decision D — Discovered MCP tools are wrapped, then lease-checked; defaults-deny

Each tool returned by `tools/list` is adapted into a Keystone `Tool` (`{descriptor, input, run(args, ctx)}`). Two gates make wrapping safe:

- **Capability ceiling.** The wrapped tool's descriptor advertises only the *intersection* of what the parent extension declared (`capabilityCeiling`). A server that announces 50 tools but whose extension declares no `cmd.exec` exposes tools that always refuse.
- **Per-call lease re-check.** `run()` calls `validateLease(ctx.lease, …)` exactly like built-in tools: the call must present a lease covering a `cmd.exec` resource equal to the server command. No covering lease → `ToolRefusedError`. The adapter never mints a lease, never widens one, and the kernel still issued it against the envelope + contract.

The adapter trusts **nothing** about the child's result shape beyond JSON-RPC framing; a call that times out, errors, exits early, or returns non-JSON is reported as a failed/timeout `ToolResult`, never as success.

### Decision E — Real supervision: handshake/call timeouts, bounded restart, isolation

The adapter owns the child process lifecycle:

- handshake and every `tools/call` have a timeout (a lease may shorten it, never lengthen it);
- on timeout the process group is killed (mirroring `spawnCapture`);
- a crash triggers a bounded restart (configurable max), after which the server is **isolated** with the named trigger (`timeout` / `crash`), so a flaky or hostile child cannot loop forever and the registry records *why* it was cut off;
- `stop()` kills the process group so no orphan holds the workspace.

Conformance probes exercised at install/activation prove the *honest failure modes* too: a server that never handshakes, that returns garbage on `tools/list`, that exits immediately, and that emits oversized frames are all refused rather than trusted.

### Decision F — On-disk Skills are inspected, never granted

A Skill is a directory containing `SKILL.md` (frontmatter `name`/`description`, optional `metadata` that may declare side-effect hints) and optional `resources/` and `scripts/`. The loader is **read-only and progressive**:

- *discovery* reads only frontmatter — cheap, no script execution;
- *body* (`SKILL.md` prose) loads on demand the first time the skill is used;
- a declared `resource/script` reads/loads on demand;
- **installing or listing a Skill grants no capability and runs no script.** Content enters as `untrusted` provenance.

`uninstall` is removing the directory from the scanned roots; `upgrade` is detected by a content digest that changes between scans (surfaced as "modified", never auto-reloaded as authority). Conformance checks: frontmatter shape, that every referenced `scripts/*` exists, and that a skill cannot declare itself a verifier or a lease.

## Boundaries (what this deliberately does NOT do)

- No remote transport, no download, no marketplace, no HTTP/SSE MCP — stdio local only.
- The adapter writes no authoritative state: it records observations and hands isolation events to the registry; the kernel still folds every state change.
- We cannot cryptographically digest an *external* stdio command. For `local_path` stdio servers the trust anchor is the directory the user explicitly pointed at, plus a conformance probe that the declared command resolves. This is weaker than digesting bundled bytes and is stated as a known limit, not papered over.
- Skills are playbooks the model may read; they cannot execute themselves — running a `scripts/*` file would still require its own lease through the normal tool boundary.
