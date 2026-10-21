# Governed Extension Integration

All public extension exports below come from `@keystone/extensions`. The
runtime already declares the workspace dependency; no dependency installation
or shared package metadata change is required.

## Lifecycle HTTP Service

```ts
const service = new ExtensionLifecycleService(defaultRegistryLocation(paths.home));
await service.list();
const review = await service.review(directory); // static, never imports code
await service.install(directory, review.reviewHash, true);
await service.probe(review.read.manifest.name, { reviewHash: review.reviewHash, decision });
await service.activate(review.read.manifest.name, { reviewHash: review.reviewHash, decision });
await service.disable(name);
await service.uninstall(name);
await service.rollback(name, previousReviewHash, true);
```

The authenticated parent HTTP boundary constructs a `UserDecision`, not the
model or the extension:

```ts
const decision = userDecisionSchema.parse({
  decisionId: newId("dec"),
  taskId, branchId, at: nowIso(), recordedBy: "user",
  decision: "allow", rationale: "User approved this reviewed version",
  appliesTo: {
    capability: "extension.activate",
    resources: [extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});
```

Use `"activate"` instead of `"probe"` for activation consent. The resource
format is `extension:<name>@<version>:<reviewHash>:<action>`. Consent must be
live and refer to actual reviewed bytes. A probe decision cannot authorize
activation. Command, irreversible and external-access extensions require an
activation decision; registry activation never grants task capabilities.
Install's `confirmed: true` is a separate authenticated user confirmation.
The service does not authenticate an HTTP caller or invent task/branch IDs.

Review discloses file/mode changes, added/removed capabilities and permission
changes. Upgrades invalidate old hashes and retain up to 128 historical
registrations. Rollback succeeds only when the old original source is still
available with the old reviewed bytes. Uninstall retains metadata/history and
never deletes user code. Registry updates lock, reread and atomically replace
one document. A crashed writer's lock requires explicit recovery; it is not
stolen merely because time elapsed.

## Task Host

```ts
const host = createTaskExtensionHost({
  service, taskId, branchId, rootPath,
  resources: ["src/example.ts"], // 1-64 exact relative regular files
  execute: async (request, run) => {
    // Parent authorizes using KernelSession and records consumption/results.
    // Never mint or rewrite a lease here.
    return run(actualKernelLease);
  },
});
const tools = await host.tools(); // Tool objects
const verifiers = await host.verifiers(); // structural Verifier objects
await host.callTool("extension.example", args);
await host.skillContext(name, { kind: "metadata" });
await host.skillContext(name, { kind: "body" });
await host.skillContext(name, { kind: "resource", path: "resources/guide.md" });
const mcpDescriptors = await host.mcpTools(protocolExtensionName);
await host.callMcpTool(protocolExtensionName, advertisedToolName, args);
await host.close();
```

`ExtensionExecutionRequest` includes task/branch, an extension subject ID
bound to name/version/reviewHash, capability, resources and exact parameters.
Every lease must bind `contentHash(request.parameters)` and the same subject,
task, branch, capability and resources. Requests with unavailable/tampered
extensions, wrong subjects, exhausted leases or different parameters are
refused. The callback is single-use. The host performs no kernel state writes.

Supported task JS entries declare only `fs.read`. Each call runs reviewed
copied package bytes in a fresh child and copies only authorized task files
(1 MiB per file, 4 MiB total). It receives no host paths, credentials, lease,
ledger, live project or callable kernel APIs. Node permissions deny
writes/spawn/addons; module hooks/global restrictions block ordinary network,
loader and Inspector entry points. Limits are at most 5 seconds/64 KiB.
Disable/uninstall on the same lifecycle service cancels its in-flight calls.
Integrity is rechecked before and after operations.
The task host pins its first observed version/reviewHash. A same-name upgrade
cannot silently replace a running task's tool or Skill; assemble a new host.

These are process/Node restrictions, **not an OS sandbox** or a guarantee
against a Node/V8 exploit. Arbitrary write-capable JS and other runtimes are
not exposed. Generic extension verifier outcomes remain untrusted `E1`,
with `canSatisfyRequiredCondition: false` and no claimed independence axes.
They are observations, never kernel Evidence.

## Runtime Helper

Import `assembleTaskExtensions` directly from
`packages/runtime/src/extension-integration.ts`; no shared index change is
required:

```ts
const assembled = await assembleTaskExtensions(
  service, session, workPath, exactReadFiles, signal, { paths },
);
// Include assembled.descriptors in Builder prompts.
// Include assembled.verifiers in the Assurance Loop.
const handled = await assembled.executeTool(proposal);
if (handled !== undefined) {
  // Return handled; skip standard authorize()/recordExecution().
  // It includes leaseId, artifactId and executionRecorded: true.
}
// Unmatched proposals continue through the existing standard dispatcher.
await assembled.close();
```

This helper assembles read-only JS tools/verifiers and active Skill metadata.
Tool wrappers ignore Builder leases and call `host.callTool`. Operations use
`session.authorizeOperation` with the extension subject, exact parameters,
resources, a one-call budget, and untrusted-source attribution. Results plus
provenance go to `putArtifact`. `executeTool` records the original proposal
using the actual extension lease exactly once; `recordExecution` consumes it.
Direct wrapper/verifier calls instead call `consumeExecutionLease`. Measured
wall time is recorded using `recordBudget`. Parent callers must not repeat
consumption or execution recording.

Use `{ paths }` for a non-default Keystone home; the five-argument form uses
`resolveKeystonePaths()`. Create a new assembly on each task/branch. Execution
must occur only while `authorizeOperation` admits the session state. Generic
extension verifiers cannot close a required condition.

## MCP And Lab

`McpSession` pins stdio to `2024-11-05`, caps complete and incomplete frames,
drains diagnostics without logging them, removes abort listeners, and never
retries tool calls with unknown side effects. Timeout/cancel stops the child.
`wrapMcpTools` requires task/branch/extension binding and a parameter hash
from `mcpCallParameters(session, toolName, args)`, including launch digest.
The task host launches only reviewed Node stdio scripts without declared
write/network/credential requirements, through a `cmd.exec` lease. It
handshakes, discovers/calls and stops within one authorized operation.

`McpHttpSession` is a separate native-fetch JSON Streamable HTTP subset pinned
to `2025-03-26`, with a required per-RPC `authorize` callback, exact declared
hosts, HTTPS (HTTP only for loopback), bounded replies and no redirects,
credentials in URLs, automatic retries, SSE or background reconnect. The
current Manifest Schema declares stdio only; HTTP cannot be installed as a
Manifest transport until a separately approved Schema evolution.

`HarnessLabService({ reportsDirectory }).run(directory, { reviewHash,
decision, execute, activationDecision? })` uses a disposable registry and an
actual temporary `README.txt` project fixture. The parent supplies its
`ExtensionLeaseExecutor`; the Lab does not mint permissions. Supported entries
run against the fixture, then temporary data is removed. `list()` and
`export(reportId)` expose bounded, hash-checked untrusted reports (128 reports,
256 KiB each). A successful Lab report never establishes completion truth.

Skills expose bounded metadata/body/declared resources with digest and
untrusted derivation provenance. Changed files require inspection again.
Scripts are disclosure-only and cannot be read as resources or auto-run.
