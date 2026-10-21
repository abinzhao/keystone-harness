# ADR-0010: Native Model Capability Negotiation and Provider Adapters (v1)

- **Status**: Accepted
- **Date**: 2026-10-20
- **Decision basis**: the kernel invariants, package boundaries, credential isolation, data-egress rules, and compatibility policy in the public architecture and governance documents
- **Relates to**: ADR-0001 (evidence-native loop), ADR-0004 (zero runtime deps), ADR-0008 (desktop shell / BYOK onboarding)

## Context

`@keystone/models` today ships exactly one HTTP adapter — the OpenAI-compatible
**Chat Completions** client — plus a scripted/offline adapter. It is deliberately
a *text envelope*: the runtime describes tools in the prompt and the model returns
a JSON action envelope that `parseActionEnvelope` validates. Two problems make a
v1 capability layer necessary:

1. **The descriptor lies about tools.** `buildAdapter` sets
   `capabilities.tools = true` for every HTTP model, while the Chat Completions
   adapter *refuses* a non-empty `tools` array with `ModelToolsUnsupportedError`
   before any network call. The declared capability and the implemented behaviour
   disagree — the exact "silent contract drift" the error type exists to prevent.
2. **Only one wire protocol is spoken.** BYOK users who chose a native provider
   surface (OpenAI Responses, Anthropic Messages, Gemini GenerateContent) had no
   way to use that surface's native tool calling or structured output without
   standing up a shim that speaks Chat Completions. There was also no vocabulary to
   declare *which* protocol a model speaks, so the router could not tell a
   text-envelope endpoint from a native-tools endpoint.

The kernel invariant this must respect is narrow and absolute: **adapters propose,
they never authorise.** An adapter maps provider-native request/response shapes to
and from Keystone's neutral envelope; it holds no task state, no authority, no
long-lived secret, and never writes authoritative state.

## Decision

### 1. One capability model, declared honestly

Every `ModelDescriptor` carries a single `capabilities` block. A capability is
listed as `true` **only when this adapter implements it and a mock-server test
proves it**; we do not declare a knob a provider supports but we do not map.

| Field | Meaning | v1 value |
|---|---|---|
| `nativeTools` | Accepts provider-native function/tool definitions and returns structured tool calls (`ModelToolCall[]`) | per adapter, below |
| `structuredOutput` | Sends a provider-native constraint that the output be a JSON object/schema | per adapter, below |
| `streaming` | Consumes an SSE/streaming response incrementally | **`false` for every v1 adapter** |
| `multimodal` | Accepts non-text (image/audio) content parts | **`false` for every v1 adapter** |
| `contextTokens` | Declared context window; never invented when unknown | configured or documented default |

`streaming` and `multimodal` are `false` in v1 on purpose. The adapters implement
a single request/response, text-only round trip. We are not shipping a half-wired
streaming consumer or an image-part mapper and then claiming the box is checked;
the capability block is the contract, and a false here must not be silently
overridden (see §3).

### 2. Four protocols, one neutral envelope

A model config entry names a `protocol`. The composition root (`buildAdapter`)
selects the matching adapter; the kernel never imports a provider.

| `protocol` | Wire surface | `nativeTools` | `structuredOutput` |
|---|---|---|---|
| `openai-chat` (default) | OpenAI-compatible `POST /chat/completions` (existing, retained) | `false` | `true` (`response_format: json_object`) |
| `openai-responses` | OpenAI `POST /responses` | `true` | `true` (`text.format`) |
| `anthropic-messages` | Anthropic `POST /v1/messages` (`x-api-key` + `anthropic-version`) | `true` | `false` |
| `gemini-generate` | Gemini `POST /v1beta/models/{model}:generateContent` (`x-goog-api-key`) | `true` | `true` (`generationConfig.responseMimeType`) |

- `openai-chat` is **retained unchanged in behaviour** and remains the default so
  existing local runtimes (Ollama, vLLM, any OpenAI-compatible server) keep
  working.
- Each native adapter maps provider-native tool definitions and tool-call payloads
  to/from the neutral `ModelToolCall { id, name, args }`. The adapter never
  executes a tool — it only maps; execution stays behind the Capability Lease.
- Anthropic gets `structuredOutput: false` honestly: it has no `response_format`
  knob. It is still usable for the JSON action envelope because the caller
  (`parseActionEnvelope`) validates the shape regardless of provider; an
  un-enforced-but-validated answer is *not* the same as a silently dropped feature.

### 3. Explicit degradation and refusal — never silent

The router is the only place capability matching happens, and it refuses loudly
rather than dropping a feature:

- **`nativeTools` is a hard filter.** If a request carries `tools.length > 0`,
  the router routes only to adapters whose `capabilities.nativeTools === true`.
  If no routed adapter qualifies, it throws `ModelCapabilityUnsatisfiedError`
  **before any network call** — it does not pick a text-envelope adapter that
  would silently discard the tool descriptors. `openai-chat` still independently
  throws `ModelToolsUnsupportedError` if called with tools, as defence in depth.
- **`structuredOutput` is preferred, not filtered.** The adapter sends the
  enforcement knob when it has one; otherwise the JSON shape is requested in the
  prompt and *always* schema-validated by the caller. Because validation is the
  safety net, a `structuredOutput: false` adapter does not corrupt the result —
  it may produce prose, which surfaces as a `ModelProtocolError`, never as a
  fabricated action.
- **`streaming` / `multimodal` are not requested in v1.** The runtime sends a
  plain text request with no streaming and no non-text parts, so there is nothing
  to drop. A future caller that asks for streaming must receive a refusal from a
  non-streaming adapter rather than a fake "buffered stream".
- All refusal errors are **permanent configuration mismatches
  (`retriable: false`)**, not provider faults: the router must not treat "this
  model cannot do what you asked" as "the model is down, try again".

### 4. Provider errors, retryability, and secrets

Shared HTTP classification (one helper used by every adapter, no SDK):

| Signal | Class | `retriable` |
|---|---|---|
| HTTP 401 / 403 | credential rejected | `false` |
| HTTP 404 | model/endpoint not found | `false` |
| HTTP 408 / 429 / 5xx | provider transient | `true` |
| timeout / abort / network error | transport transient | `true` |
| any other 4xx | bad request / permanent | `false` |

The resolved secret is redacted from **every** error path (including caught
provider bodies and stack messages) by string replacement before the error leaves
the adapter, and is never placed in the descriptor, config, event, or log.

### 5. Config and descriptor migration (backward compatible)

- `keystone.config.model` is versioned **1.0.0 → 2.0.0**. It gains one optional
  field, `protocol` (the enum in §2). An entry written by 1.0.0 with no `protocol`
  is read back unchanged and defaulted to `openai-chat`. **No old config becomes
  unreadable**; no secret is ever materialised on read.
- `keystone.agent.modelDescriptor` is versioned **1.0.0 → 1.1.0**. Its
  capability block renames `tools → nativeTools` and `jsonMode → structuredOutput`
  and adds `multimodal`. The descriptor is constructed in code (never persisted to
  the ledger), so this is a contained rename; the runtime only reads
  `id/provider/modelName/dataEgress`, which are untouched.
- `defaultConfig()` writes `schemaVersion: "keystone.config@2.0.0"`; `loadConfig`
  still accepts a 1.0.0 file (it parses, defaults `protocol`, and round-trips).

### 6. Egress disclosure stays honest

`describeEgress()` already reports host, `local`, and data classes per role. This
change additionally surfaces the negotiated `protocol` and the declared
`nativeTools`/`structuredOutput` so the user can see, before a call, both where the
data goes and which protocol is actually carrying it.

### 7. Testing and no-live-calls rule

- Every adapter is tested against an in-process mock `fetch` (no outbound network,
  no real credentials): request mapping, response mapping, tool-call mapping,
  secret redaction on error, and retryability classification.
- The capability filter is tested directly: a tools request never reaches a
  text-envelope adapter, and an unsatisfiable request fails loudly.
- No test performs a live provider call, and no capability is marked `true` without
  a passing mapping test.

## Consequences

- A BYOK user selects a provider preset and gets that provider's native surface;
  a user who points at an OpenAI-compatible local server keeps the text envelope.
- The descriptor/capability lie is closed: `openai-chat` now honestly declares
  `nativeTools: false`.
- The router can guarantee "if you asked for tools, the chosen model really has
  them", which is the precondition for later wiring a native tool loop into the
  Builder Loop without a silent downgrade.
- Cost: three new adapter modules plus a shared HTTP helper; the runtime loop is
  unchanged (it still uses the validated text envelope in v1, passing `tools: []`).
- Extensions/other packages need no change; the only public surface additions are
  the optional `protocol` config field and the renamed capability booleans.

## Rejected alternatives

- **One "smart" adapter that detects the provider and maps everything:** couples
  Keystone to provider detection heuristics and makes the declared capabilities
  unknowable from the descriptor — defeats negotiation. Explicit `protocol` wins.
- **Ship streaming and multimodal as declared but buffered/fake:** would make the
  capability block a lie and is forbidden by §3 and the no-untested-capability rule.
- **Hard-filter the router on `structuredOutput`/`multimodal` too:** would make
  Anthropic (no `response_format`) unrouteable for the JSON envelope, and the
  upstream `parseActionEnvelope` validation already makes an un-enforced JSON
  answer safe rather than silent. Hard-filtering is reserved for `nativeTools`,
  where absence *does* cause silent loss.
- **Use provider SDKs:** would pull runtime dependencies, telemetry, and a second
  retry/auth semantics between the key and the request (ADR-0004); the platform
  `fetch` surface is retained.
- **Silently default a missing `protocol` to whichever adapter "looks like" the
  host:** a guessed protocol is a silent semantic choice; defaulting to the
  already-supported `openai-chat` preserves prior behaviour explicitly.
