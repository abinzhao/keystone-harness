# Keystone M0–M3 Implementation Plan

> For agentic workers: use the installed `executing-plans` and `test-driven-development` skills. Execute the checkbox steps, record observed RED/GREEN results, and continue within the approved scope without asking for approval again.

**Goal:** Deliver the approved trustworthy local workbench, project/file/settings workflows and typed image/text input.

**Architecture:** Keep `KernelSession` as the sole task authority. Use native ESM/DOM modules over the authenticated Run Protocol, and preserve the Swift/WKWebView carrier. Each task retains its model/configuration snapshot; attachments are content addressed and provenance preserving.

**Tech Stack:** TypeScript, Node ≥22.18 native type stripping, `node:test`, native browser JavaScript/CSS, Swift/Cocoa/WebKit; zero added production runtime dependencies.

**Approved scope:** M0–M3 only, user confirmation 2026-10-21. M4–M8 remain the subsequent roadmap. Local branch `feat/workbench-m0-m3`. No publish, push, merge or production-resource mutations.

**Delivery status:** M0–M3 implementation and local acceptance completed. Latest `pnpm run verify`: typecheck passed, 535/535 tests passed. External-provider, real Keychain permission, exhaustive GUI and independent model review limits remain explicit in [acceptance.md](./acceptance.md); they are not represented as passes.

**Existing user changes:** `.gitignore` and `.keystone-native-rc-audit/` must remain untouched. Research reports are existing deliverables. Do not restore deleted temporary audit scripts.

## Shared verification

Run the focused test first, then `pnpm run typecheck` and `pnpm test` after integration. Browser tests use temporary Git fixtures and a distinct Keystone data root, never actual project history or credentials. Native testing must identify its actual platform/tool boundary. Real providers require a configured, authorized account/budget; otherwise record the unverified item truthfully.

Before kernel/schema/protocol changes, maintain ADR-0014 and schema compatibility notes. Meaningful refusal, invalidation, cancellation and conflict cases are required.

## Task 1 — Document invariant changes

Files: `docs/adr/0014-trustworthy-workbench-and-multimodal-input.md`; the corresponding schema/version notes as each schema changes.

- [x] Record proof identity/current-workspace admission, full execution binding, post-wait stop, controlled human edits, settings snapshots and typed attachments.
- [x] Add each concrete schema/protocol version decision after the implementation's exact shape is established.
- [x] Link conformance and regression cases to the final interfaces.

## Task 2 — Proof admission and consistent exports

Files: `packages/kernel/src/proof/evaluate.ts`, `graph.ts`, `package.ts`; `packages/kernel/src/kernel.ts`; `packages/kernel/test/proof.test.ts`, `project-evidence.test.ts`; `packages/extensions/test/extensions.test.ts`.

- [x] RED: add Schema-valid records from a foreign task, branch, contract, revision or producer; add an incomplete required observation and stale workspace evidence. Each must remain unproven.
- [x] Run `node --test packages/kernel/test/proof.test.ts` and record the expected admission failures.
- [x] Enforce identity, producer/version, provenance, incomplete observation and snapshot applicability before condition satisfaction.
- [x] Use the same workspace input in completion and export; preserve historical events and provide a current-invalid projection.
- [x] GREEN: run proof/project-evidence tests plus a conformance case where a client tries to use foreign evidence.

## Task 3 — Full execution scope, stop and accounting

Files: `packages/kernel/src/kernel.ts`, `lease/lease.ts`, `ledger/ledger.ts`; `packages/schemas/src/schemas/capability.ts`; `packages/tools/src/guard.ts`, `shell.ts`; `packages/verifiers/src/run.ts`, `scope.ts`; `packages/runtime/src/keystone-runtime.ts`, `verification.ts`; matching existing tests.

- [x] RED: hold a model response, queue stop/pause, release the response and assert zero subsequent leases/writes.
- [x] RED: substitute command argv/environment/resource values after authorization and require refusal.
- [x] RED: report one in-scope edit while a command produces an additional out-of-scope file; final proof must fail.
- [x] RED: assert actual model usage and elapsed time enter the budget ledger, including cancellation/error paths.
- [x] Run focused kernel/tools/runtime/verifier tests and record expected failures.
- [x] Enforce task activity and action binding; inspect complete pre/post workspace changes and preserve existing dirty attribution.
- [x] Route verification/model execution through applicable authorization and resource-budget decisions; disclose available sandbox guarantees honestly.
- [x] Validate persisted latest chain tails when appending; protect committed state and atomic visibility.
- [x] GREEN: run `node --test packages/kernel/test/kernel.test.ts packages/kernel/test/ledger.test.ts packages/tools/test/tools.test.ts packages/verifiers/test/verifiers.test.ts packages/runtime/test/workbench-api.test.ts`.

## Task 4 — Static extension review boundary

Files: `packages/extensions/src/manager.ts`, `conformance.ts`, `verifier-entry-probe.ts`; `packages/cli/src/commands/extension.ts`; relevant extension/CLI tests.

- [x] RED: an inspected verifier entry attempts a visible side effect; static inspection must not execute it.
- [x] Run `node --test packages/extensions/test/extensions.test.ts packages/cli/test/extension-command.test.ts`.
- [x] Separate static inspection from explicitly authorized bounded probes; distinguish content integrity from local-path trust and registry state from running activation.
- [x] Preserve existing reference-extension installation/conformance behavior using an isolated probe path.
- [x] GREEN: the refusal case and reference-extension tests pass; no third-party entry runs in the trusted host.

## Task 5 — Client/assets boundary and workbench structure

Files: `packages/runtime/web/workbench.html`; new `web/styles/`, `web/client/`, `web/state/`, `web/components/`, `web/views/`; `packages/runtime/src/server.ts`; `packages/runtime/test/workbench-page.test.ts`, new browser client tests; `packages/i18n/src/catalog/`.

- [x] Verify assets are served from a confined allowlist with correct MIME/CSP, and traversal cannot read other files.
- [x] RED: simulate rapid task selection with reordered requests; only the current selection commits detail/proof/trace.
- [x] Establish typed API client, atomic selection versions, abortable requests, drafts and reconnection.
- [x] Replace the monolithic page with the approved project/task navigation, central workspace and accessible proof/decision inspector.
- [x] Implement system/light/dark theme, comfortable/compact density, panel collapse/resize, keyboard navigation and commands.
- [x] All visible Chinese/English copy uses catalogs; old static tests are updated only to reflect approved behavior.
- [x] GREEN: API/client tests pass, and representative 1280/900/375px pages preserve all primary actions without overflow.

## Task 6 — Independent project registry and workspace projections

Files: new `packages/runtime/src/projects/`; new schema(s) under `packages/schemas/src/schemas/`; `packages/runtime/src/server.ts`; corresponding runtime tests.

- [x] RED: register a Git project without creating a task; list/select/pin/rename/archive/remove it, preserving user code.
- [x] RED: reject missing/non-Git/escaped paths, canonicalize duplicate directories and separate linked workspaces.
- [x] Add `/v1/projects` read/register and project metadata operations with validated schema and confined paths.
- [x] Return current branch/dirty state, support/scan status, root, identity and tasks; expose失联/reconnect behavior.
- [x] Integrate workspace/project choice with task composer and persisted per-project drafts.
- [x] GREEN: real temporary Git repositories exercise registration, duplicate/relocation handling and isolation.

## Task 7 — Controlled file surface and Diff

Files: new runtime file service and routes; `packages/runtime/src/diff.ts`; `packages/tools/src/fs.ts`; relevant kernel entry points; new file API tests and UI file/Diff modules.

- [x] RED: paginated tree/read/search rejects traversal/symlinks outside the permitted workspace and handles binary/large files explicitly.
- [x] RED: edit with a stale expected hash returns a conflict; create/rename/delete cannot overwrite existing content or mix user/agent changes.
- [x] Add read projections and human-origin, lease-bound file mutations with compensating artifacts and evidence invalidation.
- [x] Add file tabs, line navigation, `@` references, Git states, unified/split Diff, search and revision-feedback drafts.
- [x] Add independent command panel with lease/status/output/environment/reproduction information.
- [x] GREEN: temporary fixture tests validate content/hash conflicts, all file mutations, proof invalidation and unchanged outside files.

## Task 8 — Settings snapshots and model routing

Files: `packages/models/src/config.ts`, `router.ts`, `providers.ts`; `packages/runtime/src/server.ts` and new configuration service; `packages/desktop/src/config-bridge.ts`, `shell.ts`; new settings API tests.

- [x] RED: save a model/protocol while a gated task runs; the active task keeps its adapter and no process restart occurs.
- [x] RED: new tasks use updated config; stable IDs distinguish identical model names at different endpoints.
- [x] RED: native protocol discovery/generation errors are reported accurately and secrets do not return in projections.
- [x] Implement config read/update with revision/optimistic conflict checks, role/fallback routes and task snapshots.
- [x] Separate discovery, connection, generation and save/application; requests are user-triggered and usage is recorded.
- [x] Add settings pages for presentation, models, workspace, execution/rights, data, privacy and notifications; display effective scope and source.
- [x] GREEN: `node --test packages/models/test/models.test.ts packages/models/test/native-adapters.test.ts packages/desktop/test/config-bridge.test.ts packages/desktop/test/shell.test.ts` plus settings API tests.

## Task 9 — Credentials and native controls

Files: `packages/models/src/credentials.ts` and credential broker module; `packages/desktop/src-native/KeystoneWindow.swift`, `folder-picker.ts`, configuration bridge; matching tests.

- [x] RED: write-only broker projections, secret-safe process inputs/errors, explicit legacy migration and failed migration preserve source.
- [x] Implement macOS Keychain-backed broker with typed handle operations; native secret input never appears in argv/logs.
- [x] Add Settings/Cmd+, and NSOpenPanel bridge where the native carrier is available; direct Web retains clear path selection.
- [x] Ensure setting changes and window-close behavior preserve safe runtime control.
- [x] GREEN: deterministic broker tests, actual macOS build/menu/picker-object self-test and window rendering; interactive native permission/picker states remain unverified.

## Task 10 — Data inventory, cleanup and migration

Files: `packages/runtime/src/data.ts`, storage/routes/UI; matching runtime/kernel tests.

- [x] RED: cleanup of active task, referenced proof/checkpoint artifact or frozen user rule is refused with impact information.
- [x] Implement categorized inventory and preview, safe derived-cache cleanup, retention settings, export and copy/verify/switch migration.
- [x] Return explicit deletion/cleanup effects, reload affected projections and preserve protected authoritative rules; never delete the managed repository. Automatic retention and individual rule revocation remain later scope.
- [x] GREEN: reference fixtures survive cleanup, code hashes remain unchanged, unsafe removal is rejected.

## Task 11 — Typed text/image attachment pipeline

Files: new attachment service/routes and schema(s); `packages/models/src/types.ts`, each provider mapper, `router.ts`; `packages/runtime/src/keystone-runtime.ts`, context planner; UI composer; new schema/model/runtime attachment tests.

- [x] RED: reject unsupported image types, invalid byte signatures, path references, oversize/count limits and foreign task/project attachments.
- [x] RED: text-only adapters refuse images before network; image-capable adapters preserve typed parts and MIME; legacy string messages still work.
- [x] Store original artifacts outside user repositories, retain source/hash/MIME/bytes metadata and derive bounded context lazily.
- [x] Map PNG/JPEG/WebP to all relevant provider protocols with explicit per-model capability declaration.
- [x] Integrate attachment references into task input/context, egress preview and retained task history; cancellation preserves drafts.
- [x] Add button/drop/paste screenshot/file references, removal, validation state and first-batch limits (10 files, 20MiB/image, 10MiB/text).
- [x] GREEN: schema/provider/fixture API tests cover accepted and rejected inputs, cancellation/replay and zero unintended cloud fallback.

## Task 12 — Integration and first-batch acceptance

Files: runtime/desktop tests, browser journeys, `reports/2026-10-21-keystone-ui/execution.md`, `prd-coverage.md`, ADR/schema compatibility notes.

- [x] Run focused tests for newly integrated behavior, then `pnpm run verify`.
- [x] Exercise real browser project selection→settings→task→file/Diff→proof and image/text input on isolated fixtures.
- [x] Verify keyboard, light/dark, three viewports, 200% CSS zoom, stale request protection and permission/cancellation tests; exhaustive native browser zoom/drop/paste GUI coverage remains open.
- [x] Build/run native carrier where available; record GUI vs non-GUI validation accurately.
- [x] Inspect final diff and check that all M0–M3 work items have actual behavior and evidence; repair gaps before declaring completion. Independent model review was attempted but unavailable; recorded in acceptance.
- [x] Update PRD coverage only for newly verified requirements; later milestones remain open.
- [x] Present result, commands/results and unverified external-provider/platform limits. No remote push/merge/publish.

## Execution record

| Date | Task | Observed result | Next |
|---|---|---|---|
| 2026-10-21 | Preparation | User approved M0–M3; created `feat/workbench-m0-m3`; existing user changes preserved; ADR-0014 written before code | Begin Task 2/3 RED tests and exact interface contracts |
| 2026-10-21 | M0 proof | Proof admission regressions observed RED; proof/project-evidence/conformance 60/60 GREEN. Foreign identities/producers, incomplete observation and stale fingerprints cannot prove current work | Integrate current projections and all clients |
| 2026-10-21 | M0 execution | Initial runtime stop test created `src/late.js` after pause; kernel foreign/stale session tests failed. After fixes, kernel+ledger 25/25 GREEN, command binding tool tests 17/17 GREEN; actual ignored out-of-scope edits trigger needs_attention | Broaden integration only after outstanding service work is complete |
| 2026-10-21 | Command identification | New verifier authorization exposed npm projects being profiled as `pnpm test`. npm/yarn/missing-manager regression RED then GREEN. Acceptance fixture store moved outside Git root to match the storage invariant | Keep package-manager source authoritative |
| 2026-10-21 | Extension inspection | Agent reported focused extension/CLI 48 GREEN and extension/reference/CLI 114 GREEN. `prepareLocalInstall` is static; `probeLocalInstall` needs a matching review hash and user decision | Verify integration and report application vs OS isolation |
| 2026-10-21 | First service integration | Attachment/settings HTTP regressions RED (404), then 2/2 GREEN. File edit/conflict/undo/proof-invalidated and full ignored-file attribution integration 2/2 GREEN. A typecheck passed before the data agent began adding its RED fixtures | Complete settings snapshot tests, data migration, multimodal/provider journeys and browser/native QA |
| 2026-10-21 | Final regression closure | Late verifier workspace changes and pause returned false proven RED; bounded text exceeded 569009 characters RED; then focused GREEN. Added latest-failure admission, exact recorded irreversible decisions, proposal producer provenance, preserved canonical project roots and effective budgets | Integrated local acceptance |
| 2026-10-21 | Full integration | `pnpm run verify` typecheck + 535/535 tests GREEN, no skips. Test concurrency capped at 4 after independently passing suites timed out under whole-machine contention | Retain external/provider/platform limits |
| 2026-10-21 | Browser/native | Real Chromium project→settings→file edit/undo→repair/proof→unified/split Diff→command→attachments→data cleanup verified; 1280/900/375 no page overflow, 200% CSS zoom fixed. Native Swift build, 6 AppKit and 5 credential memory checks, `.app` process and window screenshot verified | Deliver acceptance report; M4–M8 open |

## Interface coordination

Freeze concrete API names and response schemas before UI/backend delegation. One writer owns each file; especially `kernel.ts`, `keystone-runtime.ts`, `server.ts`, schema exports and i18n catalogs. Independent agents may own proof-only modules, credential/provider modules, frontend assets or new project/file modules, but must not independently change shared entry points. Integration is performed by the controller and verified before moving on.
