# ADR-0014: Trustworthy Workbench and Typed Local Attachments

- Status: Accepted for implementation, 2026-10-21
- Basis: PRD v1.0, invariants 1–5, ADR-0002/0003/0005/0008/0009/0010/0013, approved M0–M3 design
- Scope: proof admission, execution/stop boundaries, project/file/settings workbench, model configuration application, typed text/image attachments
- Product design: `reports/2026-10-21-keystone-ui/iteration-plan.md`

## Context

The current source preview has a usable single-project scripted engineering loop, but its workbench hides project navigation in the default view, has no full file/settings surface, and exposes only text model messages. Review found gaps in evidence identity/version admission, final workspace scope checking, stop handling, configuration restarts, and extension inspection isolation.

The approved first batch preserves the shared runtime and the native macOS carrier. It implements M0–M3 without promoting the release to stable or claiming that the PRD's M4–M8 capabilities have shipped.

## Decisions

### 1. A proof is admitted against the current contract and branch

Evidence must match task, branch, contract identity and the applicable contract revision. A record's `valid` flag is insufficient. The condition must also match the declared verifier and version; unresolved required observations and invalid provenance cannot satisfy completion.

Older-revision evidence may be retained for historical inspection, but requires an explicit applicability path before reuse. This batch does not silently treat an earlier valid record as proof of a revised contract.

Completion and export use the same admission path and workspace identity. Current workspace changes do not rewrite historical events; they invalidate the current proof projection. Scope checks examine the complete workspace delta while preserving attribution of pre-existing user modifications.

### 2. Stopping prevents further side effects

Kernel authorization rejects inactive, paused, stopped or terminal tasks. Runtime control is checked after model waits and before every new action, not only before a request. A response arriving after a stop cannot obtain a new lease.

Command execution binds the proposal's executable, arguments, working directory and allowed environment to authorization. Model egress and verification execution must preserve matching resource/budget decisions; neither creates an independent authority. Application-level checks and OS isolation are disclosed separately, and unsupported isolation guarantees are not advertised.

Human command execution requires a recorded, live user decision matching task, branch, capability, exact resource list and canonical parameters hash. This permits the specifically confirmed irreversible command without changing the reversible/compensable autonomy schema or bypassing its command and workspace limits. Kernel operation admission verifies the decision event exists; a model-supplied object cannot substitute for that event. The resulting output stays an action receipt, never verification evidence.

### 3. The workbench is a projection, not an authority

Native ESM/DOM modules own communication, selection, drafts and rendering. They consume authenticated Run Protocol projections. No client reads credentials, writes ledgers, edits evidence, or marks completion.

Project navigation is available without starting a task. A project and a workspace remain distinct: task selection cannot move its workspace. Stale asynchronous selections are discarded before mutating the current view. Sidebar and inspector collapse responsively while pending decisions and proof validity remain accessible.

### 4. Human file edits use a controlled execution path

Read operations remain confined to the registered workspace and applicable read policy. File edits carry an expected content hash. Conflicts do not overwrite current content. Human-origin changes are recorded separately from agent changes and invalidate affected current evidence.

Create, rename, delete and undo retain compensating data. They cannot reset the repository or overwrite pre-existing modifications. Metadata removal and cache clearing do not remove user code. Cleanup must honor active tasks and proof/checkpoint references.

### 5. Saving configuration does not restart active work

Configuration saving and applying are separate operations. A new validated configuration version affects subsequent tasks; active tasks retain their configuration snapshot until an explicit safe transition. Changing a provider, protocol or display name cannot overwrite an unrelated model entry.

Connection discovery, authentication checks and real generation probes are distinct outcomes. Probes are user-triggered; no network call occurs merely while typing. Each probe declares its endpoint, model and usage.

Secrets are write-only handles. macOS uses a credential broker backed by Keychain; migrating legacy files is explicit and verified. Secrets do not enter command-line arguments, model context, logs, evidence, UI projections or exported proof.

### 6. Attachments are typed, content addressed and provenance preserving

First-batch inputs are text/file references and PNG/JPEG/WebP images. Original bytes are stored outside managed repositories as content-addressed artifacts. Events reference metadata and artifact identities rather than embedding large binary payloads.

Typed message parts distinguish text and image data. Existing string messages retain their meaning and normalize to text. Providers map parts explicitly and reject unsupported modalities before sending. A model's capability declaration is not represented as live-provider verification.

Attachment import, processing, context selection and egress are separate operations. Cancellation retains the task draft, removes the attachment from future selection and does not imply a completed task. Sources and derived content retain provenance, trust, hashes and relevant page/line metadata. Local-to-cloud fallback cannot widen approved egress.

### 7. Inspection cannot execute unknown code in the trusted host

Static extension review precedes consent. Behavioral probes run within a separate bounded execution context with a temporary workspace; unchecked verifier entry imports do not run in the trusted process. Registry status is distinguished from actual runtime activation.

Full plugin hosting, remote MCP, ACP, Harness Lab and plugin creation remain later milestones unless needed to close a first-batch trust defect.

## Invariant impact

| Invariant | Enforcement |
|---|---|
| 1. Models cannot change authority | Model content and typed attachments remain proposals/observations; proof admission is deterministic |
| 2. Kernel events change authoritative state | File changes, contract revisions, lease decisions and invalidation use `KernelSession`; UI state is disposable |
| 3. Side effects require leases | Full action binding, post-wait stop checks, confined execution and controlled human edits |
| 4. Provenance propagates | Original/derived attachments, configuration routing, evidence references and cleanup preserve sources and invalidation |
| 5. Extensions cannot escalate | Static review, consent, isolated probing, bounded bridge and distinction between declaration and runtime activation |

## Compatibility and versions

- Correcting evidence admission and stop enforcement does not change existing field meanings. Formerly under-specified or mismatched proof is not accepted as current proof; its historical record stays readable.
- Additive protocol projections/routes and attachment metadata require a protocol minor-version increment and explicit capabilities.
- New schema fields are optional where old data can retain its meaning. Each changed schema receives its own compatibility note and version; package versions are independent.
- A later failure from the same task, branch, contract revision and verifier supersedes earlier passing support for that condition and workspace. The pure admission query derives this from evidence, so exports cannot omit a failure list to resurrect an old pass. Foreign failures cannot invalidate local evidence.
- Any required field removal, meaning change or incompatible persisted layout must be handled as a major change with migration guidance, rather than being folded into this batch as an undocumented minor.
- Existing configuration and task records remain readable. Unsupported future records are offered as read-only export, not silently truncated or executed.
- Native WebKit and direct Web clients share the same Run Protocol semantics. Desktop-only credential/picker/menu bridges cannot bypass kernel authorization.

### First implementation interface decisions

- `keystone.capability.constraints@1.1.0` and `keystone.capability.lease@1.1.0` add optional `parametersHash`. New execution grants bind the canonical proposal parameters; existing historical grants remain readable. Tools check the binding before executing. The digest binds the constraints, budget and validity interval as well as resource identity.
- `KernelSession.authorizeOperation` is a composition-side, generic capability entry for model/verifier/human subjects. It does not widen the contract or autonomy. Inactive tasks are refused. Execution results consume leases and record measured budget deltas; model usage is recorded even when a response is discarded following a user stop.
- A writer compares its in-memory tip with the durable ledger while holding the task lock, and folds the proposed event before publishing it. Stale writers and torn tails require recovery rather than appending into ambiguous state.
- Runtime verification records the workspace fingerprint it actually checks. Completion and exported projections accept the same fingerprint and verifier failures; a later workspace observation cannot reuse stale proof. Full pre/post snapshots detect unreported command edits, including existing dirty files whose content changes during execution.
- Run Protocol `1.3.0` adds project, file, settings, attachment and safe data projections. `task.created` and `action.executed` receive optional snapshot/input/origin metadata; existing event data retain their meaning. New attachment and workbench schemas start at `1.0.0`.
- `action.proposed` records the actual fallback producer before authorization; historical data without proposal events stays readable. New irreversible grants require a matching recorded decision and its `modifications.parametersHash`, using existing decision fields rather than a parallel permission format.
- Local HTTP models require a loopback endpoint. All provider transports refuse redirects, so a declared endpoint cannot redirect attached content outside its lease/egress destination. Both the shared HTTP helper and the legacy Chat adapter honor pre-aborted signals.
- Settings defaults are applied consistently in contract preview and subsequent tasks; active runs retain their original router/Contract. Native data migration switches the runtime and settings bridge only after verified copy, retaining the credential-service identity without exporting keys.

## Conformance and acceptance

Required first-batch cases include:

1. Foreign task/branch/contract/revision, incompatible producer, unresolved required observation and stale workspace proof are rejected.
2. A model reply after stop/pause cannot cause another lease or tool side effect.
3. Altered argv/environment/resource values fail action binding.
4. Human file edits reject stale hashes, preserve original modifications, record distinct origin and invalidate current proof.
5. Saving model settings preserves active runs and changes only subsequent task configuration.
6. Text-only models reject images before transport; text/image-capable adapters preserve MIME, bytes and source identity.
7. Attachment type/size/path escapes, cancellation and invalid references fail without losing drafts or altering code.
8. Unknown extension entry code is not evaluated by static inspection.
9. Desktop/Web/CLI projections retain matching contract, evidence and completion meaning.
10. Keyboard navigation and narrow-window layouts retain project/task/decision access.

Implemented regression mapping:

| Case | Executable evidence |
|---|---|
| 1 | `kernel/test/proof.test.ts`, `project-evidence.test.ts`, `extensions/test/proof-conformance.test.ts`, `cli/test/cli.test.ts` |
| 2, 3 | `kernel/test/kernel.test.ts`, `ledger.test.ts`, `tools/test/tools.test.ts`, `runtime/test/{workbench-api,execution-boundary}.test.ts` |
| 4 | `runtime/test/{files,file-workbench-api,commands-api}.test.ts` |
| 5 | `models/test/{config-snapshots,router-hooks}.test.ts`, `runtime/test/settings-live-api.test.ts`, `desktop/test/{settings-shell,data-switch}.test.ts` |
| 6, 7 | `models/test/{multimodal,transport-boundary}.test.ts`, `runtime/test/attachments-api.test.ts`, `workbench-client.test.ts` |
| 8 | `extensions/test/extensions.test.ts`, `cli/test/extension-command.test.ts` |
| 9, 10 | `runtime/test/{server,workbench-page,workbench-client}.test.ts`, browser/native screenshots and `reports/2026-10-21-keystone-ui/acceptance.md` |

Local acceptance completed with typecheck and 535 passing tests. Commercial provider capability, real Keychain permission prompts, full OS sandbox guarantees, distribution/signing and independent model review are explicitly not inferred from these tests.

## Rollback

The old workbench can be retained during migration, but it cannot bypass corrected admission or action checks. Original task events and artifacts remain unchanged. New attachments/configuration retain read-only metadata export. Configuration migration preserves the old source until verification and an explicit removal operation; it does not leave an undisclosed secret copy.

## Out of scope

This batch does not ship remote workspaces, A2A, full ACP compatibility, audio/video understanding, public plugin distribution, signed notarized applications, or a complete incremental project world model. These remain M4–M8 and have their own observable gates.
