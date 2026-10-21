# Native Settings Boundary

This shell is a view and launcher, not a task authority. Accepted ADR-0014
decisions 5 and 6 govern settings, credential isolation and input capabilities.
Settings saves never restart the supervised runtime or rewrite active tasks.

## Controller Hooks

The child receives the shell's isolated `KEYSTONE_HOME`. The controller loads
the latest config/builds adapters for new tasks; active tasks retain a
`ModelRouter.snapshot()` or an equivalent independent router.

`GET /desktop/config` returns `{revision, models}` with credential handles only.
Its revision is the config-file revision from `loadConfigSnapshot`, not the
combined controller settings revision.

`POST /desktop/config/save` accepts
`{revision?, baseUrl, modelName, protocol?, multimodal?, provider?, apiKey?}`.
Send the file revision for stale-page conflict detection. Omission remains
compatible with first-run clients and still compares revisions between read
and atomic write. Stable identity is normalized endpoint + protocol + model
name. Existing legacy IDs and role routes are preserved. Credential replacement
uses a new handle so active tasks keep the old reference. Old referenced handles
are retained; retirement/garbage collection is not implemented here.

After saving, the shell calls authenticated `GET /v1/settings` to refresh the
controller's projection. The response adds `runtimeNotified`; false means the
save succeeded but notification was unavailable, not that a restart occurred.
No settings POST containing credential material is required.

Direct `GET/POST /v1/settings` proxy to the controller unchanged, including its
`{revision, config?, presentation?}` POST shape and combined revision/conflicts.
Both settings and desktop routes require the shell nonce cookie/header and
reject a mismatching browser Origin. Tokens are injected upstream only.

`DesktopShell({paths, credentials?})` and
`DesktopConfigBridge({paths, credentials?, legacyCredentials?, fetchImpl?})`
support explicit broker injection. The default is Keychain on macOS, never a
silent plaintext fallback. After data-root migration, inject
`createCredentialBroker({credentialsDir, service: preservedService})` in both
processes. The factory now also persists/reads the non-secret identity at
`credentialIdentityPath(credentialsDir)`, normally `<home>/credential-service.json`.
Initialize it at the source root before migration; copy/verify that file before
switching runtime/store. New-root defaults reuse it without resolving secrets.

## Explicit Checks

`POST /desktop/config/test` discovers models with the selected protocol's auth
headers. It does not spend generation tokens or verify image/tool capability.
Endpoints without discovery return an honest error, not an assumed success.

`POST /desktop/config/generate` separately performs a bounded text generation.
It uses the selected protocol and returns success/failure, never model output
or keys. This check spends tokens and must be a distinct user action. It does
not establish image capability; `multimodal` remains an explicit declaration.

`POST /desktop/credential/migrate` accepts
`{handle, confirmed: true, removeSource?: boolean}`. Copy and target verification
precede optional source removal. Different existing target secrets are refused.
The default file-backed bridge refuses a migration back into its own file store.
No native startup automatically reads legacy keys.

## Native Controls

Cmd+, and the Settings menu dispatch `keystone:settings` on `window`; the
workbench listens for this event. Native pages can call
`await window.keystoneNative.pickFolder()`, which resolves
`{supported: true, path}` or `{supported: true, cancelled: true}`.
The WKWebView reply bridge accepts only main-frame requests from the exact
loopback shell origin. Navigation outside that origin is refused.

`POST /desktop/pick-folder` uses the same compiled helper's `NSOpenPanel`
subcommand. Missing helper/non-macOS means `supported: false` and manual path
entry, not a guessed AppleScript bridge. Selection never opens a project.

## Build And Verification

`pnpm --filter @keystone/desktop desktop:build-native` compiles both helpers,
stages `bin/Keystone.app`, and installs the model helper under
`packages/models/bin`. `node packages/desktop/scripts/build-native.ts --out DIR`
builds entirely into an isolated output directory.

`node --test "packages/models/test/**/*.test.ts" "packages/desktop/test/**/*.test.ts"`
uses temporary homes, injected credentials and local fixture servers. Native
tests compile real Swift/Cocoa/WebKit/Security code, inspect actual menu/panel
objects, and run credential operations against memory storage.

The staged `.app` is the native carrier, not a complete distributable containing
Node/runtime resources. Signing, notarization, interactive GUI actions, real
Keychain permission prompts, provider accounts and controller integration are
separate verification steps. These tests never read real `~/.keystone` keys.
