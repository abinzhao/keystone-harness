# Workbench Integration Contracts

This client is a presentation layer. All authoritative writes and admission
decisions belong to the local service and kernel. It adds no production dependency.
Requests use the existing same-origin bearer closure, CSP and `/v1` boundary.

## Requests

| Endpoint | Method and JSON |
| --- | --- |
| `/v1/projects/:id/cognition` | GET projection; POST `{}` to refresh the scan |
| `/v1/projects/:id/facts/:factId` | PATCH correction `{expectedHash, statement}` or freeze/unfreeze `{expectedHash, frozen: true/false}` |
| `/v1/projects/:id/experience/:entryId` | POST `{action: "confirm"}` or `{action: "revoke", reason}` |
| `/v1/extensions` | GET installed/discovery projection |
| `/v1/extensions/review` | POST `{directory}` |
| `/v1/extensions/install` | POST `{directory, reviewHash, confirmed: true}` |
| `/v1/extensions/:name/:action` | POST `{reviewHash, confirmed: true}` for all four actions; hash omitted only for `disable`/`uninstall` if absent |
| `/v1/lab` | GET reports; POST `{directory, reviewHash, confirmed: true}` after `/v1/extensions/review` |
| `/v1/tasks/:id/resume` | POST `{}`; reload selected task/run after acknowledgement |
| `/v1/tasks/:id/start` | POST a fresh local autonomy boundary for an existing `draft`; the recorded request, references and attachments are immutable |
| `/v1/tasks/:id/branches` | GET branches; POST `{checkpointId, label}` |
| `/v1/tasks/:id/compare?left=:branchId&right=:branchId` | GET comparison |
| `/v1/tasks/:id/verify-comparison` | POST `{confirmed: true, maxWallClockMs?, timeoutMs?}`; observation-only protected baseline/candidate checks |
| `/v1/input-processors?projectId=:id` | GET built-in and explicitly configured project processors |
| `/v1/input-processors/process` | POST `{projectId, processorName, confirmed: true, raw|attachmentId, range?}`; returns review-required derived text and attachment without task submission |
| `/v1/input-processors/configure` | POST exact active extension binding `{projectId, name, kind, extensionName, mimeTypes, reviewHash, confirmed: true}` |
| `/v1/collaboration` | GET capability/status projection |
| `/v1/collaboration/initialize` | POST confirmed local exchange initialization |
| `/v1/collaboration/export` | POST confirmed complete local task export; recovery source files require a separate opt-in |
| `/v1/collaboration/import` | POST the exact reviewed bundle digest into untrusted quarantine |
| `/v1/collaboration/adopt-task` | POST an imported digest and fresh request; creates a new local `draft` only |
| `/v1/collaboration/verify` | POST `{signed, expected}` |
| `/v1/collaboration/preview` | POST `{root}`; local bundle read/validation only |
| `/v1/release/readiness` | GET real release-gate projection |

IDs are percent-encoded as path segments; comparison values use URLSearchParams.
Fact hashes must be supplied by the cognition API as `fact.hash`, computed from
the authoritative fact. The browser never computes an authoritative hash or falls
back to timestamp concurrency. A missing hash makes a fact read-only.

The fact PATCH contract supersedes the earlier action/expectedUpdatedAt proposal.
The UI does not send `invalidated`: no invalidation action is requested in this view.

## Response Expectations

Top-level projections or a `{data: ...}` envelope are accepted. Unknown shapes
remain inspectable and are labelled unrecognized, never interpreted as an empty
successful list.

- Cognition: `{facts: [...], experience: {entries: [...], candidates: [...]}, scan}`.
  `projectFacts`, an experience array, or top-level `entries`/`candidates` are also
  displayed. Facts need `factId` (or `id`), `hash`, `statement`, `status`/`frozen`,
  `source`/provenance, `subjects`/scope, `derivedFrom`/dependencies and timestamps.
  Experience needs `entryId` (or `candidateId`/`experienceId`/`id`); candidates
  retain their provenance and quarantine label.
- Extensions: `{extensions: [...]}` or `{installed: [...]}`, optionally
  `discovery`, `available` or `catalog`. Entries may carry a nested `manifest`.
  Review returns `{reviewHash, read: {manifest}, blockers, upgrade, ...}` (also
  top-level `manifest` or a `review` envelope). Missing hashes, explicit static
  failures or blockers disable installation. Upgrade versions, changed files and
  capability differences are visible before confirmation. Editing the directory
  invalidates the review. Installed entries need `reviewHash` for probe/activate;
  those actions are unavailable when the version/hash cannot be identified.
- Lab: `{reports: [...]}` (also `runs`/`entries`); POST returns the actual report,
  including failures/isolation restrictions. Reports are downloadable as JSON.
- Branches: `{branches: [{branchId, label, ...}]}` (also `entries` and `id`).
  Compare may carry `changes`, `diff`, `budget` and `proof`. Full responses remain
  inspectable; comparisons do not become independent evidence.
- Baseline comparison: `keystone.baseline-comparison/1` reports `observed` or
  `blocked`, a conservative verdict, both recreated variants and limitations.
  It always has `evidenceLevel: null`, never reuses parent Proof and is cancelled
  when the request or view closes.
- Input processors: status identifies the exact reviewed processor and supported
  MIME/size limits. Processing persists the original and derived attachment with
  provenance, returns bounded text for review and always states
  `requiresReview: true` and `autoSubmit: false`.
- Collaboration: `{version, externalCompatibility, signatures: string,
  portableBundles: string, importAvailable, adoptionAvailable,
  delegation: {outboundAvailable}, candidates, limits}`. Optional historical
  `signatures`, `imports`, `delegations`, `shared` arrays are displayed.
  Verify returns `{ok, authority: "integrity_only", reason?}`; a rejected
  verification is a real result, not an assumed transport failure.
  `signed` is `{document, envelope}`. `expected` is explicitly entered by the
  user: `{purpose, taskId, contractDigest, conditionIds, environmentDigest}`.
  The client does not copy it from `envelope.binding`. Preview returns the
  full bundle preview (`root`, `digest`, manifest/checks/provenance as supplied).
  Obvious secret fields/private material and malformed JSON are rejected before
  sending; this is a UI guard, not a replacement for server validation.
  Mutations require a separate visible confirmation. Imports remain quarantined,
  adoption creates a fresh local draft, and delegation transport never changes
  parent completion without later local verification.
- Readiness: `{releaseVersion, channel, localReady, stableReady, gates}` (also
  `checks`/`items` or a `readiness` envelope). Gate rows use
  `{gateId, status, reason, requiredFor?, evidenceDigest?}` and remain fully
  inspectable. A local-ready RC is not displayed as a stable-ready release.

Extension lifecycle, Lab, collaboration verify/preview and readiness shapes
above match the integrated HTTP adapter. The parent adapter issues kernel decisions, leases,
budgets, validity and isolation; a browser confirmation cannot manufacture them.
The UI never constructs `UserDecision`, task/branch IDs or `CapabilityLease`.
For `ExtensionLifecycleService.probe`, the adapter must bind an authenticated user
decision to `extensionDecisionResource(manifest, reviewHash, "probe")` and provide
bounded probe limits. Activation must preserve the same version/hash/action
binding. `HarnessLabService.run` additionally needs its reviewed hash, decision
and isolation inputs; the HTTP request is not a direct call
to that service class. These are mandatory integration checks, not client defaults.
Experience confirmation/revocation and branch creation/comparison remain API
contracts for parent integration; unavailable routes are shown honestly.

## Failure And Selection

HTTP 404/405/501/503 and `{supported:false}`/`{available:false}` are explained as
unavailable capabilities. Refusal bodies remain visible. Conflicts preserve known
records and require refresh; no optimistic fact/experience/lifecycle edit is made.
Reads use AbortController and version checks. Disposal prevents late results and
confirmation continuations from entering another view. Mutations serialize and
reload the service projection; an unsuccessful reload is visibly stale.
An acknowledged mutation result remains inspectable even if the list refresh
fails. Pending branch-name and settings drafts survive polling. Fact correction
never falls back to timestamp concurrency or a browser-computed hash.

Verification is isolated `node:test` client/DOM and structural CSS/HTML tests.
Browser layout, accessibility-tree and parent endpoint integration verification
belong to the parent workflow; fixture responses are not release evidence.

## UI Verification

Run the five focused files with `node --test`:
`workbench-page.test.ts`, `workbench-client.test.ts`,
`workbench-services.test.ts`, `workbench-presentation.test.ts` and
`workbench-shell-client.test.ts` under `packages/runtime/test/`.

The shell test imports the actual `client/main.js` against a minimal isolated DOM
and fixture API. It verifies module bootstrap, project/task navigation, centered
versus bottom composer placement, background-preserving settings, page routing,
and no unintended mutation. Structural checks cover confined module assets,
catalog completeness, native dialogs and responsive/theme rules. They do not
verify rendered geometry at 375/900/1280, focus accessibility in a real browser,
or WKWebView behavior. Those acceptance checks remain with the parent.
