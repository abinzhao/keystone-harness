# ADR-0008: Desktop Shell — Same-Origin Proxy, First-Run BYOK, and the Write-Confirmation Gate

- **Status**: Accepted (2026-10-20)
- **Date**: 2026-10-20
- **Decision basis**: `需求文档.md` ST-03 (single Run Protocol boundary), 1.4 (no second semantics), 9.1 / 9.4 (trust, extension rules), 11.3 (credentials), HI-03/HI-04 (user decisions, envelope widening), OT-02/OT-03 (Outcome Contract); ADR-0002 (kernel is sole state authority), ADR-0003 (event ledger), ADR-0004 (TypeScript, zero runtime dependencies); existing `packages/runtime/src/server.ts` (`keystone.run.protocol`), `packages/models/src/{config,credentials}.ts`.

## Context

The CLI can already `keystone serve`, which binds the Run Protocol to loopback and serves the `workbench.html` page. That is a developer boundary: the bearer token is printed to the terminal and pasted into the URL fragment. An ordinary desktop user should not read a token, choose a port, or open a terminal at all. They need:

1. A thin desktop shell that launches the runtime, supervises it, and presents one window.
2. A first-run wizard that enters a BYOK / local OpenAI-compatible endpoint and validates it, persisting the key through the existing credential store (never echoed back).
3. A simple default view that hides the four-zone advanced surface, but keeps it one toggle away.
4. A guarantee that a task which can **write** anything first shows the compiled Outcome Contract and waits for an explicit confirmation; a read-only task may run immediately.

The hard constraint (repo invariant 3, 5; PRD ST-03) is that the desktop shell must not become a second runtime, a second source of truth, or a privileged extension. It composes the existing kernel/runtime; it never re-implements contract compilation, state folding, or permission issuance.

## Decisions

### Decision A — The shell is a supervised same-origin reverse proxy, not a second runtime

A new zero-dependency package `packages/desktop` is the thin desktop shell. It:

- Spawns `keystone serve --json` as a **supervised child process**, reads the single JSON startup record (loopback host, ephemeral port, bearer token), and owns the child's lifecycle.
- Listens on its **own** loopback port and serves the whole UI from that origin. Every `GET /` and `/v1/*` request is reverse-proxied to the child Run Protocol server, and the shell **injects the `Authorization: Bearer <token>` header server-side**.
- The webview/browser therefore holds **no token** and sees no port; the token never travels in a URL fragment, a log line, or client-readable storage. Because the page and the API share one origin, no CORS policy is opened at all (there is no cross-origin request to allow).

The child may be restarted (see Decision C) without the webview noticing beyond a reload: the shell reads the fresh token on each startup and keeps injecting it.

**Why a proxy rather than running the runtime in-process:** process supervision must be real. If the runtime child crashes, the shell detects the non-zero exit, shows the user a restart path, and tears the child down cleanly on shell exit (no orphaned runtime holding a workspace writer lock). In-process code sharing would give us no crash boundary and no child cleanup.

### Decision B — Shell-private control surface is NOT part of the Run Protocol

On the shell origin only, the shell adds a small private API under `/desktop/*`:

- `GET  /desktop/bootstrap` — `{ shell: true, configured: boolean, hasModel: boolean, language }`.
- `GET  /desktop/config` — the configured model entries (ids, kinds, base URLs, enabled flags) — **never the secret**, mirroring `listHandles()`'s "handles, not material" rule.
- `POST /desktop/config/test` — probe the endpoint the user typed (an unauthenticated-ish `GET {baseUrl}/models` with the supplied key) and report reachability / auth as ok or an honest error.
- `POST /desktop/config/save` — persist through the **existing** `FileCredentialStore.set(handle, secret)` (mode 0600) and `saveConfig(config)` (which stores only a `credentialHandle` reference, never the secret). Then restart the child.
- `POST /desktop/pick-folder` — native folder chooser bridge (Decision D).

These routes exist on the shell process, touch only the local config/credential files through the existing `@keystone/models` APIs, and are **not** reachable from the Run Protocol server. They are deliberately excluded from `keystone.run.protocol`: a protocol client (CI, another editor) has no desktop window and no onboarding state. Documenting them here as shell-private keeps the versioned protocol small.

### Decision C — First-run BYOK writes config, then the supervised child reloads it

The child `keystone serve` reads `~/.keystone/config.json` exactly once at start. When the wizard saves a new model, the shell therefore **restarts the supervised child** so the new adapter is actually registered. The UI polls `/desktop/bootstrap` until `hasModel` is true, then reloads. No config state is kept in the shell itself.

A saved entry reuses the existing `keystone.config@1.0.0` schema (`kind: "cloud" | "local"`, `baseUrl` including the `/v1` segment, `credentialHandle`). The secret is written to `credentials/<handle>.json` and is never returned to the page after save — a subsequent `GET /desktop/config` shows only the handle, never the value.

### Decision D — Native folder selection is a best-effort bridge

`POST /desktop/pick-folder` shells out to the platform chooser (`osascript` `choose folder` on macOS; a documented "unsupported elsewhere" response on other OSes). It returns an absolute POSIX path the workbench drops into the workspace field. It is an enhancement, not a requirement: typing a path always works. The bridge is read-only (it returns a path; it opens no project and changes no state).

### Decision E — The Run Protocol gains ONE additive, read-only endpoint

To show a readable contract **before** a side effect, the protocol adds:

- `POST /v1/contract/preview` — body `{ workspacePath, request, writePaths?, allowedCommands? }`.

It resolves the project id, runs the **read-only** `detectProjectProfile`, builds the same `AutonomyEnvelope` the run would, and calls the pure `compileContract` from the engineering pack. It returns the projected contract (`projectContract(...)`, the same projection used by task detail) plus the open questions. It creates **no `KernelSession`, no task, no ledger event, no workspace write**. It is a draft for the user to read.

This initial endpoint was additive and moved the protocol from `keystone.run.protocol@1.0.0` to `1.1.0`; ADR-0013 later adds the risk-grade/startMode fields and moves the current protocol to `1.2.0`. Older clients can ignore the additive preview/risk fields, while the server remains the authority for startup admission.

### Decision F — The preview is mandatory; startup is risk-graded

Read-only submissions continue directly. Every write submission first calls `POST /v1/contract/preview` and renders the goal, authorised scope, completion conditions, budget and open questions. ADR-0013 supersedes the original binary confirmation rule: a clean, narrow, reversible task with no ambiguity or external action may start automatically after its preview when project/user policy permits; ambiguity, scope expansion, irreversible/external/high-risk actions or policy requirements still require an explicit click; overlapping pre-existing dirty paths are refused rather than mixed. The server re-derives the grade on `POST /v1/tasks`, so the page cannot self-approve or widen permissions.

### Decision G — Simple mode is the default; four-zone advanced is retained

The page carries a `data-mode` attribute defaulting to `simple`. Simple mode is a single-column composer: pick a folder (native bridge when available), describe the task, choose read vs. write, submit, and watch status/result inline. The existing three-column / four-zone layout is unchanged in behavior and is reachable via one toggle, persisted in `localStorage`. Narrow windows already collapse to one column (the existing `@media (max-width: 860px)` rule); simple mode reuses that stack.

### Decision H — macOS uses a native Swift/WKWebView window; desktop dependencies remain isolated

The ordinary-user macOS entry is a small native host compiled from `packages/desktop/src-native/KeystoneWindow.swift` with the system Swift toolchain and Cocoa/WebKit frameworks. It embeds the same shell origin in `WKWebView`; it does not import the runtime, open a `KernelSession`, or fork any protocol semantics. `packages/desktop` supervises both the window and the Run Protocol child: closing the only window exits the helper and tears down the shell, proxy, runtime child, and instance lock. A per-start nonce is exchanged on the first same-origin navigation and becomes an HttpOnly cookie for `/desktop/*`, so a local process that merely discovers the ephemeral port cannot invoke shell-private routes.

The helper supplies a normal macOS menu/responder chain for editing shortcuts, Cmd-+/−/0 page zoom, a resizable 1200×800 window, and a 360×480 minimum size so the workbench's `<860px` single-column layout remains reachable. On unsupported platforms, or when the helper has not been built, the shell degrades loudly to the system browser. The helper adds **no third-party runtime dependency** and all native build inputs stay inside `packages/desktop`; kernel/runtime/tools remain zero-dependency TypeScript packages.

This source-tree RC includes the reproducible Swift source and build command plus a locally built Apple-silicon helper used for verification. It is not a universal binary and not a packaged `.app`; each release architecture must rebuild the helper from source before packaging.

## Invariants check

- The shell cannot change authoritative state: it only proxies, manages config files through existing APIs, and restarts its child. It never opens a `KernelSession` (kernel invariant 1, 2).
- No extension grants itself permission: onboarding writes a model **reference** and a credential the user supplied; widening the autonomy envelope still happens only through a recorded user decision at runtime (invariant 5).
- Secrets propagate correctly: the secret lives in a 0600 file, is read only to make a model call, and is never projected to the UI (PRD 11.3; invariant 4).
- The protocol stays the single boundary; the shell-private routes are documented as out-of-protocol and read-only except the deliberately audited config save.

## Out of scope for this slice

- A packaged, signed, notarized universal `.app`; this slice provides the native WKWebView host and reproducible build input, not public distribution artifacts.
- Bundling a model; the wizard is BYOK / an existing local OpenAI-compatible endpoint only.
- Any change to kernel authority, the ledger, or Capability Lease issuance.
