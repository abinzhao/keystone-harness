# Local Input Processor Integration

This is the M6 input conversion interface, not an installed PDF parser, speech
recognizer or OCR engine. The built-in `text-document@1.0.0` reads valid UTF-8
`.txt`, `.md`, `.json`, `.csv` and `.log`. Other conversions require an explicitly
configured, installed, reviewed and activated read-only Tool extension.

## Runtime And HTTP

Import directly from `packages/runtime/src/input-processors.ts`. No existing
runtime export, server route or composer file is changed by this implementation.

```typescript
import { ProcessorService, routeInputProcessors } from "./input-processors.ts";

const processors = new ProcessorService({
  paths,
  extensions,
  processors: [{
    name: "local-pdf",
    kind: "document",
    extensionName: "my-reviewed-pdf-tool",
    mimeTypes: ["application/pdf"],
  }],
});

// After existing HTTP authentication and bounded JSON body parsing:
const routed = await routeInputProcessors(processors, {
  method: request.method ?? "",
  pathname: url.pathname,
  projectId: url.searchParams.get("projectId") ?? undefined,
  body,
  signal: controller.signal,
});
if (routed !== undefined) {
  json(response, routed.status, routed.body);
  return;
}
```

The `extensions` value is the existing `ExtensionLifecycleService`. Constructor
bindings are trusted composition configuration. Project-specific bindings can
also be explicitly configured through the authenticated endpoint below; neither
path is an install/activate/permission API.
The caller authenticates `confirmed: true` as an explicit user operation.
Pass an AbortSignal on request disconnect, user cancellation or server shutdown.
Recreate the service when its storage paths or explicit bindings change.

| Route | Input | Response |
| --- | --- | --- |
| `GET /v1/input-processors?projectId=...` | Optional project query | `{ processors, localOnly: true, autoSubmit: false }` |
| `POST /v1/input-processors/process` | Process request below | `{ attachment, text, requiresReview: true, source, processor, range, rangeBasis, taskId, autoSubmit: false }` |
| `POST /v1/input-processors/configure` | Explicit configuration below | `{ configured: true, binding, taskId }` |

```json
{
  "projectId": "proj_<registered-workspace-id>",
  "name": "local-pdf",
  "kind": "document",
  "extensionName": "my-reviewed-pdf-tool",
  "mimeTypes": ["application/pdf"],
  "reviewHash": "<exact-installed-64-character-review-hash>",
  "confirmed": true
}
```

`ProcessorService.configure(...)` accepts this same object plus `signal`.
It verifies an active read-only Tool, binds the actual version and review hash,
and persists project-scoped mappings in `input-processors/mappings.json` under
a kernel maintenance `fs.write` lease. Repeated configuration replaces only that
project/name. Other projects' mappings are preserved. Static constructor names
and `text-document` cannot be overridden. At most 64 mappings are stored.
Changing/disabled/uninstalled extensions do not inherit activation through a
mapping; a changed review hash requires explicit reconfiguration.

Call `status(projectId)` or supply the GET query to list project-specific
bindings. Without a project, only built-in/static bindings are returned.
Configuration requires an available registered project and explicit user
confirmation, but runs no plugin code and grants no model or network access.
`reviewHash` is obtained from the existing installed extension lifecycle view.
The binding's MIME types are user-selected declarations, not proof of parser
quality. New mappings are read by the existing service on subsequent requests,
without a server restart. Do not expose this endpoint before authentication.

```json
{
  "projectId": "proj_<registered-workspace-id>",
  "processorName": "local-pdf",
  "confirmed": true,
  "raw": {
    "name": "specification.pdf",
    "mimeType": "application/pdf",
    "data": "<canonical-base64-original-bytes>"
  },
  "range": { "unit": "page", "start": 1, "end": 3 }
}
```

Supply exactly one of `raw` or `attachmentId`. `attachmentId` accepts an existing
AttachmentStore ID or an `input.*` source ID returned by a successful conversion.
Raw PDF/audio originals are persisted first as local content-addressed artifacts
and separate `input-processors/originals` metadata. They are not relabelled as
text/image attachments, bound to a Builder task or sent to a model.

The returned `attachment` is a new ready `text/plain` AttachmentStore-compatible
record. The bounded `text` enables composer preview/editing without another
artifact request. Display it as untrusted derived input, require user review,
and add its attachment ID to a draft only after user acceptance. Neither the
service nor adapter starts Builder, invokes a model or accepts the text as
authorization. Subsequent model egress remains a separate existing task decision.
Editing `text` alone does not change the persisted attachment bytes; do not
present edited text as the unchanged converter artifact.

Unavailable converters return HTTP 409 with `code: "processor_unavailable"` and
specific details. Invalid requests use 400, unsupported formats/ranges 415 and
input/output limits 413. Unknown routes return `undefined`; wrong methods 405.

## Plugin Entry

Use an existing Tool manifest with `entry.module` and `entry.export`,
`capabilities: ["fs.read"]`, only `fs_read` side effects, no transport, no hosts
and no credentials. Installation, review and activation use the existing
ExtensionLifecycleService flow; conversion never performs them implicitly.
Bindings use `kind: "document" | "audio" | "vision"` and explicit accepted MIME
types. These are input routing categories, not new ExtensionManifest kinds.

The isolated tool's `entry.run(args, context)` receives:

```typescript
// Every parameter is covered by a fresh kernel-issued extension-subject lease.
args = {
  path,             // exact relative original snapshot path
  source,           // sourceId, name, MIME, size, artifactId, full hash/provenance
  processor,        // name, actual extension version, extensionName, reviewHash
  range,            // original source selection, not independently verified
  maxOutputBytes,
};
context = { rootPath, taskId, branchId };
```

Read only `join(context.rootPath, args.path)` and return
`{ status: "succeeded", stdout: "<derived text>" }`. The host rejects writes,
ordinary network entry points, process spawning and host module imports.
Unknown extension code never loads into the trusted runtime process. The
fixture test executes a real reviewed child reading the original bytes; it
does not claim actual PDF or speech recognition quality.

## Limits And Provenance

- Built-in original input: 10 MiB; isolated plugin original snapshot: 1 MiB.
- Derived text: at most 64 KiB, optionally narrowed with `maxOutputBytes`.
  Output must be nonempty valid Unicode/UTF-8 without NUL. No silent truncation.
- Plugin runtime: at most 5 seconds, optionally narrowed with `timeoutMs`.
  The existing host also bounds all child output to 64 KiB including protocol.
- Lines/pages are one-based inclusive; byte/time ranges are zero-based,
  end-exclusive. Built-in explicit ranges support lines only.
- Plugin page/time ranges are requested metadata (`rangeBasis: "requested"`),
  not an independently verified claim that the converter honored the selection.
- Original exact bytes, full original Provenance and upstream `derivedFrom` IDs
  survive in the derived record. `provenance.extended` stores the source hash,
  artifact ID, processor version/review hash, range and maintenance task ID.
  Output always remains `untrusted`.
- Maintenance events reference original and derived-record artifacts. No Proof
  evaluation occurs; every successful or failed maintenance session is stopped.
- Private snapshot directories use mode 0700; files use 0600. Snapshot copies
  are cleaned after execution/cancellation. Original artifacts are retained for
  provenance/replay. Original retention/deletion UI is not implemented here.
- Cancellation before admission creates no maintenance task. Cancellation,
  extension disable, integrity change, timeout, oversize output or removal of
  the source during conversion cannot publish a successful derived attachment.

Native microphone capture, actual speech/OCR/PDF providers and browser composer
wiring are separate integration work, not installed capabilities of this module.
