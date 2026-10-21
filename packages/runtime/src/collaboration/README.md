# Local Collaboration v1

This additive runtime module implements ADR0015 without changing shared schemas,
kernel event meanings, runtime composition or HTTP authentication. It has no
credential store. Callers own private `KeyObject`s and supply per-operation
signing callbacks; the service accepts no private keys or tokens.

## Product Admission Design

`createLocalCollaboration` owns an ephemeral Ed25519 identity and a public-only
peer registry. Its HTTP facade requires a parent-supplied authenticated local UI
context and explicit confirmation for effects; request `decisionId` values are
not consent. Every filesystem/network effect records a fresh `UserDecision`
through `KernelSession` and obtains a resource/parameter-bound lease in a
dedicated session. Construction is synchronous and read-only; the confirmed
`initialize` action creates all exchange directories through a maintenance
lease rather than fabricating consent during factory startup.

Exports contain the verified task ledger and exactly its referenced artifacts.
Recovery capsules are refused, not silently omitted from the hash chain.
Imports remain in a separate quarantine, never in `tasks/` or the authoritative
artifact store. Adoption creates only a fresh local draft with an untrusted
reference; foreign leases, Evidence and completion are never resumed.

The current Contract validator requires at least one completion condition, so
an entirely empty maintenance Contract cannot be expressed. The helper uses an
empty engineering profile and one required, unevaluated maintenance condition,
then stops the session without evaluating Proof. There is no
`recordActionObservation` kernel API: remote claims are retained as leased
artifacts referenced by `recordExecution`, not Evidence. Project fact/experience
promotion is unavailable because existing user-confirmation promotion elevates
trust. Sharing and conflict preview remain supported without promotion.

Delegation uses its own parent task, never an existing live run. Preparing a
signed request performs no network IO. Sending requires a separate explicit UI
decision bound to a public peer, its declared endpoint, exact scope, parameters,
and byte/token/time ceilings. Stopping aborts transport and fences observations.
No imported material is included implicitly in outbound requests.

## Product Server Wiring

The product UI requires `createLocalCollaboration`, not the read-only
`CollaborationService`. In `packages/runtime/src/server.ts`, replace the import
and the constructor beside `lab`:

```ts
import { createLocalCollaboration } from "./collaboration/index.ts";

let localCollaboration = createLocalCollaboration({
  paths: () => paths,
  projects: () => projects.list(),
});
```

Replace the `segments[0] === "collaboration"` handler, **after** the existing
`authorize(request, token)` check and request accounting. Reject cross-origin
browser requests before asserting `source: "local_ui"`:

```ts
if (segments[0] === "collaboration") {
  const origin = request.headers.origin;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const localOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if ((origin !== undefined && !localOrigins.includes(origin)) ||
      request.headers["sec-fetch-site"] === "cross-site") {
    json(response, 403, { error: "local collaboration origin required" });
    return;
  }
  const result = await localCollaboration.service.handle(
    request.method ?? "GET",
    url.pathname,
    request.method === "GET" ? undefined : await readBody(request),
    { authenticated: true, source: "local_ui" },
  );
  json(response, result.status, result.body);
  return;
}
```

No-origin headless requests still need the existing bearer authentication.
Never derive this context, `recordedBy`, or a `UserDecision` from request JSON.
The body carries `confirmed: true` only after the UI confirmation; the helper
creates and records a new decision with exact parameters and resources.
Keep the server's body limit and project authorization. Do **not** hold a server
or engineering-task serialization lock across the whole delegation handler:
the helper serializes short admission/event commits, and Stop must run while
the network request is pending. Existing `storeRequests` accounting prevents
data migration while a request is active.

In successful data migration, call `await localCollaboration.dispose()` before
switching `paths`. Replace the old `new CollaborationService(...)` reassignment
after `projects = new ProjectRegistry(paths)` with:

```ts
localCollaboration = createLocalCollaboration({
  paths: () => paths,
  projects: () => projects.list(),
});
```

In `RunningServer.close()`, call `await localCollaboration.dispose()` **before**
`server.close(...)` to abort transports and stop dedicated parents. Recreating
the helper intentionally rotates its session-only identity; public peers and
portable package bytes remain in the migrated home.

The facade is not an HTTP server and does not replace authentication.

| Route | Body |
| --- | --- |
| `GET /v1/collaboration` | Public identity, peers, projects, roots, session projections and limitations |
| `GET /v1/collaboration/sources/:projectId` | Bounded local fact/experience listing with actual provenance and record digests |
| `POST /v1/collaboration/verify` | `{signed, expected}`; expected binding comes from local task/environment |
| `POST /v1/collaboration/initialize` | `{projectId, confirmed:true}`; initialize exports/inbox/quarantine through a lease |
| `POST /v1/collaboration/peers/register` | `{projectId, identityId, publicKey, endpoint?, confirmed:true}` |
| `POST /v1/collaboration/peers/revoke` | `{projectId, identityId, confirmed:true}` |
| `POST /v1/collaboration/export` | `{projectId, taskId, branchId?, confirmed:true}`; destination assigned locally |
| `POST /v1/collaboration/preview` | `{root}` inside a package directory under `roots.exports` or `roots.inbox` |
| `POST /v1/collaboration/import` | `{projectId, root, digest, confirmed:true}`; unused quarantine assigned locally |
| `POST /v1/collaboration/adopt-task` | `{projectId, importId, digest, request, confirmed:true}`; fresh draft only |
| `POST /v1/collaboration/share` | `{projectId, sourceId, sourceDigest, confirmed:true}`; re-read local record and retain its provenance |
| `POST /v1/collaboration/adopt` | Returns 501; trust-preserving project promotion unsupported |
| `POST /v1/collaboration/delegation/prepare` | `{projectId, recipientId, scopePaths, budget, parameters, confirmed:true}` |
| `POST /v1/collaboration/delegate` | `{delegationId, digest, confirmed:true}`; separate send opt-in |
| `POST /v1/collaboration/delegation/stop` | `{delegationId, confirmed:true}`; local cancellation, not remote rollback |

For an external package, place it in a fresh directory under the reported inbox
using an independently authorized local copy, then preview it in the UI. No
arbitrary workspace directory is admitted. Exported signatures are returned in
the operation receipt; integrity is not automatic peer authenticity.
The UI exposes the complete public key and operation JSON in expandable
details, rather than accepting private signing material.
Task IDs come from the selected project's existing `tasks` projection.
Sharing selects an actual local fact/experience, not hand-authored provenance
JSON; source changes are rejected by digest. Delegation uses a pinned-recipient
selector, relative-path lines, a public instruction and numeric budget fields.
Endpoint, requester identity, task identity, Contract/environment digests and
signature bindings are computed locally. Export prepopulates the signed-document
field, but never copies the expected binding from the signed envelope.
Only signature verification requires the independently supplied expected-binding
JSON.

The lower-level `CollaborationService` remains available for adapters supplying
their own `bundleRoots`, `importRoots`, `admission` and outbound hooks. Its
`decisionId`/signed-request bodies are **not** the product UI interface.
`share(input, localStatements)` creates an imported candidate; the product helper
reads local statements itself. The candidate retains original provenance, source
identity, source digest and conflicts with effective untrusted status.

## Lower-Level Hooks

`DelegationClient` is unavailable without all `OutboundHooks`. Before **any**
outbound IO, `authorize(operation)` must execute under the active parent task's
lock and call `KernelSession.authorizeOperation` twice:

- `net.fetch`, resource `[operation.host]`
- `external.write`, resource `[operation.endpoint]`
- subject `{kind: "orchestrator", id: operation.subjectId}`
- `parametersHash: operation.parametersHash` (hash of the full signed request)
- one call, TTL no longer than `operation.expiresAt` or the request wall-clock budget

The host allowlist, outbound-data classification, child scope, token allocation,
external-system policy and recorded opt-in decision must be checked by the
parent. A signature does not authorize egress. The module checks exact resources,
subject, task, payload hash, expiry and status; it consumes both leases before
POST. `currentLease(id)` must return the current event-derived lease including
revocations, not the original issuance snapshot. Revocation during IO prevents
parent observation. It must return `undefined` when the parent task is paused,
stopped, terminal or otherwise inactive, **including already-consumed grants**.
The parent should abort in-flight IO when its task stops.

`consume(id)` calls `KernelSession.consumeExecutionLease`. Failed network
attempts consume grants too. `observeParent(observation)` must persist a remote
observation through the parent kernel admission and return `{eventId}`. It must
not record an imported claim as independently verified Evidence. Budget/time
accounting is also the parent's responsibility. Only subsequent local Assurance
and kernel proof evaluation can complete a task.

`DelegationReceiver.admit(request, signal)` likewise requires local child kernel
scope/budget/lease admission before execution. The receiver does not execute tools
itself. Its injected signer signs observations, not completion decisions.

`admission.importBundle` must recheck digest and path bounds immediately before
copying to the unused destination, lease the write, validate a recorded local user
decision, append parent admission events and assign fresh local task identity.
Never resume imported effects, reuse foreign leases or copy foreign Evidence as
local completion support. `admission.adoptCandidate` similarly validates the
recorded decision and explicit conflict resolution before creating a distinct
local fact/experience through `KernelSession`, retaining upstream provenance.
Without these hooks the module refuses mutation.

## Portable Bundle

`manifest.json` uses `keystone.task-bundle/1`, task/branch/environment binding,
`ledger: {path: "ledger.jsonl", sha256, tipHash, eventCount}` and
`artifacts: [{artifactId: "art_<sha256>", path: "artifacts/<first2>/<sha256>", sha256, bytes}]`.
The `keystone.collaboration.bundle@1.1.0` validator adds the optional,
digest-bound `includesRecoveryWorkspace: true` declaration. It appears only
after explicit source-content opt-in; older manifests remain valid and imply
that recovery capsules are forbidden.
The JSONL must end in a newline and contain a complete, schema-valid single
task/branch hash chain beginning at `task.created`. Referenced content-addressed
artifacts must all be present. Unknown versions, symlinks, traversal, Windows
device paths, missing content and credential-shaped fields are refused.
The read budget is 32 MiB, the manifest 1 MiB and the artifact count 4096.
Unlisted files are ignored, not imported.

Integrity is not authenticity. Authenticity requires pinned identity keys,
nonrevoked identity, unexpired signature and expected local binding. Signature
validation never alters evidence levels, trust, Contract or completion.

## Limits And Tests

`keystone.delegation/1` is a fixed local fixture protocol inspired by delegation
patterns, **not** a claim of general A2A or third-party compatibility. Exact
idempotent retries reuse their result; changed payloads under the same key fail.
Caches are process-local, bounded to 1024 entries and expire with the request.
Durable cross-restart idempotency belongs to the parent. The product helper
persists public peer revocations but intentionally never persists its private
identity. Imported package records, candidates and prepared delegation handles
are session projections; package bytes remain quarantined across restart,
without automatically restoring adoption authority.
The product helper gives every delegation its own bounded parent Contract and
records reserved token usage conservatively; it does not implement aggregate
project budget scheduling. A custom parent must reserve child budgets across
distinct request IDs; per-request ceilings alone do not limit aggregate allocation. Requests and
responses have byte/time/token ceilings; cancellation is signed and
task/sender-bound. No redirects or URL credentials are accepted.
HTTPS destinations are possible only when explicitly configured and leased;
tests use literal loopback HTTP exclusively. The product Stop action aborts
local IO and fences parent observations; it does not silently send a remote
cancel POST or guarantee rollback. Signed remote cancellation remains a
lower-level protocol operation requiring its own explicitly authorized leases.
Leaving the UI aborts the browser wait, not an implicit remote operation.

Source-text secret detection is conservative, not exhaustive. Concurrent hostile
filesystem mutation requires OS isolation; portable validation is not a sandbox.

```sh
node --test --test-timeout=20000 packages/runtime/test/collaboration*.test.ts packages/runtime/test/workbench-services.test.ts
```
