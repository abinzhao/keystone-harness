# TRAE CLI Model Transport

Inactive-by-default model extension implementing ADR-0016. No external runtime
dependencies. The CLI is treated as an untrusted agent, not an inference API.

## Public API

- `probeTraeCli(options)` checks the canonical executable, exact version and
  required public help flags using separate kernel-authorized sandbox calls.
- `discoverTraeCliModels(options)` repeats compatibility checks, then calls
  `models --json`. Only bounded model identifiers/display names are returned.
- `createTraeCliAdapter(options)` performs compatibility checks and returns a
  structurally compatible `ModelAdapter`, `compatibility` and `transportPolicy`.
- `createTraeCliManifest({ digest, egressHosts })` requires the host's measured
  package digest and explicit destinations. The manifest does not grant access.
- `transportPolicy(extensionSubject)` returns the launcher ceiling. Exported
  `TransportProposal`, `TransportParameters`, `TransportLease` and result types
  support composition-root wiring without importing the kernel.

All helpers require `cliPath`, `endpointHost`, exact `egressHosts` and
`authorizeTransport`. Adapter creation also requires `modelName` and optionally
`id`. `complete(request)` requires its own runtime-only authorization callback;
the factory callback is used only for compatibility probes, never as a hidden
generation fallback. Missing `isActive` means inactive. Optional `checkIntegrity`
is called before every invocation and immediately before spawning.
`onIsolationViolation` receives only the fixed reason; the adapter locally
latches off after a tool or gateway violation. The runtime persists quarantine,
aborts other in-flight calls and requires a new successful review before reuse.
Activation pins the canonical executable path/digest and native resource identities.
Replacement with another binary reporting the same version still requires review.

Native login is read by CLI through a scratch-owned symlink to its exact
`auth.json`, under a separate `credential.use` lease. Keystone never opens,
copies or exports login bytes. Optional `nativeModelsFile` permits the exact
CLI-owned `models_cache.json` through the same read-only mechanism, without
reading its contents in Keystone. Writes and adjacent configuration stay denied.

## Kernel Integration

Pure preparation computes an immutable proposal without creating files or
opening sockets. Its parameters bind exact launcher/argv, canonical source path,
binary digest, private root/cwd, stdin SHA-256 and byte count, environment hash,
timeout, output/network budgets and destination names. Hash encoding matches
Keystone sorted canonical `contentHash`. No prompt is placed on argv.

The runtime must issue a `cmd.exec` lease for the exact extension subject and
`/usr/bin/sandbox-exec`, with `workingDirectory`, `timeoutMs`, `maxOutputBytes`,
`argvPrefix: ["-p"]`, and `parametersHash` from the proposal. Both Contract and
Autonomy Envelope need the transport ceiling (`subjectId` maps from
`transportPolicy.extensionSubject`). Do not add this launcher to Builder
`allowedCommands`. The runtime separately owns `model.invoke` authorization.

The transport rejects wrong subject/resource/parameters, inactive or expired
leases, excess calls and insufficient explicit budgets. Accepted lease IDs are
single-use across adapters in the process. It never rewrites kernel state.
The runtime must record lease consumption, budgets and fixed errors via
`KernelSession`, including failures; runtime authorization callbacks must not
come from model content. A callback return alone is not cryptographic issuer
authentication: its trust comes from composition-root wiring.

## Isolation

Only macOS and exact CLI version `0.210.1` are accepted. After authorization:

1. Create a mode-0700 private root with a genuinely empty `work/` cwd.
2. Copy only the public installed executable, digest-check the copy, and launch
   that copy. Homes, cache and schema files stay outside `work/` inside the root.
3. Run Apple Seatbelt through `sandbox-exec`: deny default, exact executable,
   private data subtree, OS dyld bootstrap/`/usr/lib`, metadata and random devices.
   TLS uses only the fixed public `/private/etc/ssl/cert.pem` CA bundle, read-only
   via `SSL_CERT_FILE`. No private keychain or trust-daemon IPC is granted.
   Project/user-home data, child execution/fork, direct network, Unix sockets and
   daemon/Mach services are not granted.
4. Supply a whitelist environment with empty owned TRAE/CODEX/XDG homes. No parent
   credentials, auth files, Node options, proxy settings or user configuration
   are copied. Version/help use `--no-daemon`; 0.210.1 rejects it for
   discovery and `exec`, whose IPC remains denied by Seatbelt. Discovery and
   generation receive only the separately leased, exact native resources.
   Ephemeral/config/rule suppression,
   explicit feature switches and tool-denial flags are defense in depth.
   Startup disables plugins, hooks, sub-agents, Code Mode hosts, shell snapshots,
   skill dependency installation and unbounded retries. The exact known
   Code-Mode-disabled startup notice is inert and accepted only once before the
   turn when that feature was explicitly suppressed; other error/tool activity
   is refused.
   CLI-native Argos trace and trace bodies are disabled through
   `TRAECLI_TRACE_ENABLED=false` and `TRAECLI_TRACE_LOG_BODY=false`. Metrics and
   file-log endpoint overrides pin HTTPS on `argos-data-collector.bytedance.net`;
   that host still requires explicit egress consent. Generic analytics/OTel
   switches alone do not control this version's independent exporter.
5. For discovery/generation, allow only an authenticated per-call localhost
   CONNECT gateway. It requires exact configured DNS host/443, matching visible
   TLS ClientHello SNI, no ECH, public IPv4 resolutions and pinned resolved IP.
   It denies plaintext, arbitrary ports, local destinations and IPv6. RFC1918
   resolutions require explicit `allowPrivateNetwork` consent for the exact
   declared hosts; loopback, link-local, metadata and other reserved addresses
   remain denied.
   Connections, headers, TLS hello, total bytes and lifetime are bounded. Any
   refusal immediately aborts the subprocess. It does not decrypt application
   traffic; authorization permits any HTTPS path on each declared host.
   The short handshake timeout is removed only after DNS/SNI admission and
   connection, so quiet inference retains the absolute configured lifetime.
6. Kill the process group on cancellation, timeout, flood, decode refusal or
   completion. Close all gateway sockets and remove only the owned private root.

Apple's `dyld-support.sb` is a private OS interface. Future macOS updates require
rerunning actual negative tests; unsupported startup fails, never widens policy.
The sandbox permits writes inside private scratch only, not the business project.
External same-user modification of the Keystone host process is outside this
process confinement threat model.

## Output and Limits

Accept bounded fatal-UTF-8 LF-terminated JSONL. Unknown frames, tools, hooks,
approvals, duplicate/late finals and malformed envelopes fail closed.
Final JSON is returned as inert text with `toolCalls: []`; runtime validates
individual Action Proposals. Optional public `answer` is bounded to 65,536
characters and never used as a completion verdict. Measured input/output/cache tokens are preserved.
Missing usage refuses success; missing cost is omitted, not zero.
Raw stderr, provider messages, private IDs and discovery account/quota fields are
never returned.

Defaults: 60-second process/setup lifetime, 256 KiB input/frame, 1 MiB combined
stdout/stderr, 8 MiB network; bounded configuration ceilings are enforced.
Public executable streaming hashes are limited to 512 MiB.
Descriptor `contextTokens: 4096` is a conservative routing ceiling, not a claim
about provider capacity. Images, native tool descriptors, `jsonMode: false`,
`maxTokens` and `temperature` are refused because their CLI semantics have not
been verified. The controller must not silently drop requested controls.
Manifest egress rules cover at most ten hosts across three declared data classes
to stay within the authoritative manifest's 32-rule ceiling.

## Observed Status

On 2026-10-22, local `trae-cli` resolved to
`/Users/bytedance/.local/share/traex/releases/0.210.1-aarch64-apple-darwin/traex`.
Installed public help verifies the required flags; isolated version output is
`traecli 0.210.1` with `installation: unknown`. Version/help passed actual
`KernelSession` authorization, private-copy execution and cleanup without
network or user-home access.

Actual macOS negative tests verify outside reads/writes, symlink escape,
child commands and direct sockets are denied. Native synthetic CLI tests cover
final events, measured usage, timeout, cancellation, floods and tool refusal.
Real gateway sockets verify CONNECT/auth/host/port/SNI and cancellation refusals.

The workbench integrates status, explicit discovery, generation checks, activation,
model selection and lifecycle persistence. A generation check is required for the
exact reviewed configuration before activation. CLI version/help have passed
real local checks. Native model discovery returns the installed model catalog.
Use the discovered name (`Seed-2.1-Turbo` in this installation), rather than its
private backend configuration name.
The observed enterprise binary returns a model answer and measured usage but
also attempts a plaintext POST to `argos-data-collector.bytedance.net` on exit.
The gateway rejected that request. Accepted native settings `analytics.enabled=false`,
`trae_telemetry.enabled=false` and OTel exporter settings did not suppress this
collector in the original bounded check. The corrected whitelist environment
uses the independent native trace switches and HTTPS exporter endpoints described
above. Two real generation checks completed; an instrumented run observed
15 HTTPS CONNECT requests and zero plaintext requests. The production
`ModelPluginService` separately discovered 22 models, passed generation and
persisted activation for `Seed-2.1-Turbo` after explicit user authorization.
The gateway's plaintext, host, port, DNS and SNI rules are unchanged.
Encrypted HTTPS telemetry can still occur; this fix does not claim all telemetry
is absent. Model output quality and protocol conformance remain separately
validated, and a forbidden native activity still quarantines the plugin.
Compatibility alone is not activation or engineering proof. Windows/Linux remain
unsupported. Manifest integrity covers all package implementation files.

For the observed enterprise installation, requests include
`code.byted.org` (native authentication), `copilot-cn.bytedance.net` (model service)
and `mcs.zijieapi.com` (CLI telemetry), with distribution/API hosts
`traex-resource-cn.bytedance.net`, `api.enterprise.trae.cn` and
`icube-api.bytedance.net`. These observations are setup guidance, not automatic
permission. Every destination, including telemetry, must be explicitly included
and reviewed in the workbench. Undeclared hosts stop the process.

## Verification

```sh
node --test packages/extension-trae-cli/test/*.test.ts
node_modules/.bin/tsc -p packages/extension-trae-cli/tsconfig.json
KEYSTONE_TEST_INSTALLED_TRAE=1 node --test packages/extension-trae-cli/test/installed-cli.test.ts
KEYSTONE_TEST_INSTALLED_TRAE=1 node --test --test-concurrency=1 packages/extension-trae-cli/test/*.test.ts
```

The opt-in installed test runs public version/help only, never live inference or
credential extraction. Native synthetic fixture compilation needs macOS command
line tools (`/usr/bin/cc`). All fixtures and process setup are private temporary
files; no project writes, commits or pushes are performed.
