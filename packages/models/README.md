# Model Boundary

Implementation basis: accepted ADR-0014, decisions 5 and 6. Models propose
responses only; this package does not change Contracts, Leases, evidence or task
completion. The controller owns per-task adapter/config snapshots.

## Compatibility

`keystone.config` and `keystone.config.model` 2.1.0 add optional `multimodal`.
Existing 1.0.0/2.0.0 configuration remains readable and defaults to text-only.
Protocol presets describe adapter support, not a live provider verification.
Existing model IDs are retained; new IDs hash normalized endpoint, protocol and
model name. Provider labels do not establish identity.

`ModelMessage.content` accepts a string or ordered readonly text/image parts.
PNG, JPEG and WebP use raw base64, not URLs or file paths. Artifact/source IDs
stay in the caller's request and are not exported to a provider. System messages
are text-only. The attachment service must validate original byte signatures,
size, ownership, provenance and egress authorization before constructing parts.

Adapters reject invalid or unsupported content before credential resolution or
transport. Routing filters native-tools and image capabilities together and
cannot widen the primary destination's locality, endpoint or data classes on
fallback. Permanent content mismatches are not retried.

## Configuration Hooks

`loadConfigSnapshot(location)` returns `{revision, config}`. Revision is an
opaque SHA-256 of persisted bytes (`"missing"` for a fresh location).
`saveConfigSnapshot(location, {revision, config})` validates the entire config,
rejects duplicate IDs and unknown route references, serializes writers, and
atomically replaces the file. A stale revision raises `ConfigConflictError`.
`saveConfig` retains its existing API and legacy route cleanup behavior; it
validates the schema and replaces atomically. Revisioned updates additionally
validate cross-field semantics. A crashed writer can leave a `.lock` directory;
subsequent writers fail loudly instead of deleting an unverified live lock.

Native credentials use an injected `CredentialBroker` or the Security-framework
helper. Only handles/presence are projected. No automatic legacy migration or
plaintext fallback occurs on native startup.

`CredentialBroker` extends `CredentialResolver` with `set(handle, secret)`,
`delete(handle)` and `listHandles(): {handle, present}[]`. Use
`createCredentialBroker({credentialsDir, service?, identityFile?, native?, helperPath?, invoke?})` in both
the desktop bridge and the controller's runtime adapter construction. macOS
defaults to Keychain, other platforms to the file store; isolated tests explicitly
inject a broker or `native: false`. The Keychain service is namespaced by the
credential directory, so both processes must use the same canonical directory.
Missing/denied native support fails closed rather than falling back to plaintext.

`credentialServiceName(credentialsDir)` returns the non-secret initial service
identity. Native factory startup atomically creates or reads
`credential-service.json` in the parent of `credentialsDir` (overridable with
`identityFile`). It stores only `{version: "1.0.0", service}`, never keys.
The controller must copy/verify that file during data-root migration before
switching the runtime/store. A factory at the new root automatically retains
the old service; an explicit `service` must match any existing identity.
Corrupt/conflicting identity fails closed rather than guessing another namespace.
The helper uses the preserved Keychain service without exporting or rewriting
secret bytes. Losing the identity file requires an explicitly supplied original
`service`; deriving one from the new path cannot recover old Keychain items.
The factory's small startup-only identity operation uses synchronous filesystem
IO so existing synchronous adapter composition APIs remain compatible.

`KeychainCredentialBroker({service, helperPath?, invoke?})` supports deterministic
typed helper injection. The default helper gets one JSON request on stdin with
`operation: "set" | "resolve" | "delete" | "list"`, `service`, optional `handle`
and optional `secret`. Its result is `{ok, secret?, handles?}`; only resolve
returns material to the internal resolver. No key is in argv or stderr.
`migrateLegacyCredential(source, target, handle, {confirmed: true,
removeSource?: boolean})` is a separate user action. A successful default
migration retains the legacy source; removal is explicit.
Source and target must be distinct stores. A different existing target secret is
refused rather than overwritten; migration cannot replace an active credential.

The controller must continue resolving old file handles only in an explicitly
selected legacy mode or after verified migration, not probe both stores
silently. The native helper lives at `packages/models/bin/keystone-credentials`.

## Attempt Hooks

`ModelRouter.complete(role, request, hooks?: ModelAttemptHooks)` accepts:

```ts
{
  beforeAttempt?: (descriptor: ModelDescriptor) => Promise<void>;
  afterAttempt?: (
    descriptor: ModelDescriptor,
    response: ModelResponse | undefined,
    error?: unknown,
  ) => Promise<void>;
}
```

The router validates content and filters capabilities/egress before invoking
hooks. `beforeAttempt` runs immediately before each selected adapter invocation;
it must issue the controller's endpoint-specific Lease before transport.
`afterAttempt` runs once after that invocation, with either response or error.
Adapters can still fail before transport (missing credentials, aborts), so
undefined response must not be billed as successful token usage. Hooks are never
invoked for skipped candidates. Either hook throwing aborts without fallback;
authorization or accounting failures are not model availability failures.

`snapshot(): ModelRouter` copies registration, order and role routes and freezes
cloned descriptors. Existing adapter closures are reused, not reconstructed;
injected adapters must keep their closed-over configuration immutable.
Credential replacement uses new handles; snapshots do not copy secret material.
The controller remains responsible for per-task budgets, billing, Lease issuance
and configuration snapshot lifecycle.

## Verification

Tests use temporary directories and injected transports/brokers, never the real
Keystone home or live provider accounts. `test/multimodal.test.ts` is the
adapter/routing conformance coverage for ADR-0014 decision 6.
Build native helpers with `pnpm --filter @keystone/desktop desktop:build-native`.
The native credential self-test uses memory storage and never accesses Keychain.
Live Keychain permissions and interactive authorization require separate testing.
