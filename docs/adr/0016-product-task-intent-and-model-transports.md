# ADR-0016: Task intent, model responses and governed model transports

Date: 2026-10-22
Status: Accepted for local implementation by the approved product-readiness design.

## Context

The current compiler assigns modification tests even to explicit read-only analysis.
The workbench loses unsaved file drafts on refresh, offers no direct model selection
and does not persist the model's public answer as a first-class observation.
TRAE CLI is an agent process, not an HTTP inference endpoint. Giving it the project
workspace would introduce an execution authority outside Keystone.

## Decision

1. `task.created` gains an optional `taskIntent: analysis | engineering`. Absence
   means engineering, preserving old task behavior. The kernel passes the recorded
   intent to the scenario proposer; clients cannot change it by rewriting a
   projection. Analysis contracts contain read scope only and a required read-only
   workspace condition. They do not demand modification tests. Analysis responses
   never cause `proof.satisfied`: the kernel rejects a satisfied completion
   decision and a proven export for recorded analysis intent, including when
   independent workspace evidence passes. The runtime records an orderly exit
   with an explicit unverified-answer reason after collecting that observation.
2. The kernel records a bounded `model.response_recorded` observation containing
   model identity, step, public answer, artifact reference, content hash and fixed
   `trustLevel: untrusted`. The event does not change task status, leases, evidence
   or proof. The client renders it as model output, never hidden chain-of-thought.
   Recovery and export retain its referenced artifact.
3. A model transport is an execution mechanism, not an extra tool for the Builder.
   Optional `modelTransports` entries in the user-supplied Autonomy Envelope bind
   an extension subject, executable and fixed argument prefix. The kernel may
   issue a parameter-bound `cmd.exec` lease to that exact extension subject only.
   Entries never expand `allowedCommands` for Builder tools. Both the envelope and
   Contract must contain the same transport permission. Model invocation still
   gets its own `model.invoke` lease.
4. The transport boundary verifies the lease, exact parameters, expiry and
   single-use constraints before spawning. A per-call temporary directory is
   owned by the transport and never the business project. Runtime-only transport
   authorization callbacks are not ledger authority and are rebuilt on resume.
5. The bundled TRAE model extension is activated only after explicit local review
   and compatibility checks. Its descriptor is cloud, with declared destinations.
   CLI flags that suppress tools and configuration are defense in depth; effective
   OS isolation and egress constraints must be tested. Unsupported isolation,
   unknown executable/version, unbounded output, attempted tool execution or
   altered plugin integrity cause refusal. No private API or extracted token is used.
   Native CLI authentication may read one explicitly declared CLI-owned auth file
   in place, through a separate `credential.use` lease for
   `trae-cli-native-login`. Keystone never opens, copies or returns its bytes.
   The OS profile permits only that file, not its directory, user config, hooks
   or other credentials. Writes to the login source remain denied. The filename,
   login resource handle and declared HTTPS destinations are bound to the process
   proposal and shown before activation. Both model discovery and generation use
   this exact declared resource and require their own credential lease; version
   and help probes never receive native resources. Non-interactive discovery and
   generation omit `--no-daemon`, which CLI 0.210.1 rejects in those modes; OS
   isolation continues denying Unix/Mach IPC regardless of CLI preferences.
   Missing native login requires the user's
   original CLI login flow; no unsandboxed Git login fallback is allowed.
   Enterprise installations may explicitly opt into RFC1918 destinations for
   their exact declared DNS hosts. The CONNECT gateway still requires matching
   SNI, port 443 and pinned DNS results, and rejects loopback, link-local,
   unspecified, multicast and metadata addresses. This option is shown in review,
   persisted in model config and bound to the transport parameters; it is never
   inferred from a model request or enabled for undeclared hosts.
   Activation pins the canonical CLI path, executable digest and canonical native
   login resource identity. Every later process proposal is checked against these
   approved identities before admission; replacement requires a new review.
   Disabling or quarantining the extension aborts compatibility checks and in-flight
   generation. Isolation violations quarantine the persisted registration and
   reject late responses.
   Installed CLI model metadata may be resolved through the exact native
   `models_cache.json` file, read by CLI in place through a scratch-owned symlink.
   Keystone does not open its contents. Its canonical path is reviewed and bound
   to the process proposal; writes and access to adjacent files remain denied.
   Missing metadata is an unavailable transport, never a reason to expose the
   native configuration directory.
   TLS trust uses the fixed macOS public CA bundle `/private/etc/ssl/cert.pem`,
   read-only, via `SSL_CERT_FILE`. The transport never opens certificate bytes,
   grants no private keychain or trust-daemon IPC, and does not inherit caller
   certificate configuration. The bundle path and environment are included in
   the hashed sandbox proposal; missing system trust fails closed.
   CLI 0.210.1 has a separate Argos trace/metrics/file-log path unaffected by
   analytics and OTel exporter settings. The whitelist environment pins
   `TRAECLI_TRACE_ENABLED=false` and `TRAECLI_TRACE_LOG_BODY=false`, and changes
   native metrics/file-log endpoints to their HTTPS equivalents on the same
   Argos host. These values are bound by the existing environment hash; no
   executable or user configuration is modified. Argos HTTPS still requires
   explicit destination consent and CONNECT/SNI/DNS admission. Other plaintext
   and undeclared destinations remain refused. A generation probe must complete
   under these exact reviewed bytes before activation; merely finding the
   environment variables in the binary is not proof of their effectiveness.
   The composition root supplies the output JSON Schema generated from
   `modelActionEnvelopeSchema` to the CLI. Its content hash is part of the
   process proposal; the boundary writes those exact schema bytes in scratch.
   This constrains generation without introducing a second handwritten action
   schema. The existing runtime validator still rejects invalid proposals.
   Changing schema contents requires fresh parameter-bound admission and a new
   extension review when implementation bytes change.
   A gateway bind collision occurs before the CLI starts. At most three setup
   attempts may prepare new immutable parameters and obtain new single-use
   leases within one absolute transport lifetime. An occupied port is never
   substituted in an existing lease; generation, policy, decoding or process
   failures are never replayed by this setup retry.
6. New tasks may select a registered model ID. Selection produces a route snapshot
   before compilation and start; active tasks retain their original snapshot.
   Recovery reconstructs the recorded selected-model route before checking its
   fingerprint. Registered transport permissions are independent of the default
   Builder route and remain frozen with the task.
   Configuration-backed adapters expose a digest of their public configuration
   entry, including CLI identity pins and network policy but never credential
   bytes. The runtime binds this digest into registration and execution
   fingerprints, including HTTP resume paths. Changes to an adapter's effective
   configuration cannot hide inside a recreated closure; changes to unrelated
   presentation or default routes cannot replace the task's frozen routes.
   Model changes do not revise task goals, permissions or completion rules.
7. File editor recovery drafts are presentation data with project/path/disk-hash
   binding, byte and age limits. They never write project files automatically and
   never count as Evidence. Conflicting disk contents require explicit recovery.
8. User-facing localized intervention/error descriptions are projections over
   machine fields. Canonical proof text and protocol names remain language-neutral.
9. The Builder still executes only the first proposed action per step. A finish
   marker applies when it is that first action; a later marker cannot silently
   cancel an earlier executable proposal. The next step is replanned after the
   authorized action, and only independent verification can determine completion.
10. Human clarification context resolves the selected option against the recorded
    intervention. The user's decision retains its own user-confirmed provenance;
    the question and option label retain separate untrusted provenance derived
    from the request event. Selecting an option does not promote the model's
    question or grant capabilities through prompt text. Both records remain
    replayable without trusting current client labels.
11. Exact checkpoint restoration includes regular-file permission bits. Git's
    patch captures executable changes but omits other POSIX permissions such as
    `0600`. Workspace capsules may add tracked-file modes for admitted changed
    paths; restoring them uses the existing parameter-bound filesystem lease.
    The full content/index/mode observation must still match before a branch can
    run. Legacy capsules remain usable only when that exact comparison passes;
    missing mode metadata never permits ignoring a mismatch.

## Invariants

| Invariant | Enforcement |
|---|---|
| Models cannot change authority | Fixed-trust response event; proposals still enter the kernel; no answer-driven proven status |
| Only events change state | Intent is recorded in creation; response is a kernel observation; recovery uses original event graph |
| Effects require leases | Separate model and process leases; process boundary validates exact extension subject, arguments and input hash |
| Provenance propagates | Model ID, artifact/hash and fixed untrusted label survive projection, replay and export |
| Extensions cannot escalate | Transport permission is an envelope ceiling restricted to one extension, not a general command grant |

## Compatibility

Task-created payload advances additively to 1.2.0. Existing tasks default to
engineering. The event envelope and autonomy schema advance to minor versions
for the optional intent/transport fields and response event. Existing contracts
retain their version literal and required-condition semantics; nested optional
transport ceilings do not authorize older clients to execute anything.

ModelDescriptor advances to 1.2.0 with the `trae-cli-exec` protocol identifier.
Configuration advances to 2.2.0; the loader continues accepting 1.0, 2.0 and 2.1
records. HTTP fields keep their existing meaning. CLI-specific fields do not use
an invented baseUrl. Run Protocol 1.6.0 advertises the new operations; clients that
do not understand a new protocol refuse that model and can still export old data.

No major permission or completion semantics are relaxed. Unknown fields/events in
older runtimes remain unsupported rather than silently creating authority.

## Conformance and rollback

Cases cover absent-intent compatibility, read-only analysis refusal of writes,
answers unable to satisfy proof, response replay/artifact integrity, mismatched
subject/argv/input-hash/expired transport refusals, ordinary Builder command
refusal, plugin disable/integrity failure and cancellation without late writes.
Checkpoint cases include a modified `0600` source file whose restored bytes,
index and permissions must match, with no changes to the source workspace.

Presentation drafts can be discarded without losing code or evidence. Disable
the plugin and restore HTTP routing to stop new CLI invocation; existing ledgers
are retained. Rollback never rewrites new records to impersonate older schemas.
