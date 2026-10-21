# CLI Automation Surface: Exit-Code Contract and `keystone ci`

- **Status**: Accepted (2026-10-20)
- **Scope**: `packages/cli/src/exit-codes.ts`, `packages/cli/src/commands/ci.ts`, `packages/cli/src/commands/task.ts`
- **Decision basis**: machine-readable output, explicit degraded/offline execution, non-interactive runs stopping at `needs_attention`, the rule that models cannot decide completion, and ADR-0002.

## Why a documented exit-code contract

A CI runner or a parent agent must be able to branch on the result without
parsing human prose and without trusting the model's summary. The process exit
code is therefore a **pure function of the task status and the count of pending
human decisions** — never of the model's text. It is implemented once in
`packages/cli/src/exit-codes.ts` (`exitCodeForTask`) and shared by
`keystone task run` and `keystone ci`, so the two surfaces cannot drift.

## Exit codes (authoritative)

| Code | Name | When | CI meaning |
|---|---|---|---|
| `0` | `proven` | `status === "proven"` — the Outcome Contract's required conditions were met at the required evidence level. | **green.** The delivery conditions were proven. |
| `3` | `needs attention` | `status === "needs_attention"`, or `status === "awaiting_approval"`, or at least one intervention the run could not answer in non-interactive mode. | **blocked, not failed.** The run stopped for a human decision/contract confirmation. Do not treat as a broken build; route to review. |
| `1` | `did not prove` | Any other non-proven end: `failed`, `exited_gracefully`, `stopped`, any other status, or a runtime/setup error before a verdict. | **red.** The task did not deliver a proven result. |
| `2` | `usage error` | The invocation itself was wrong (unknown command/flag, missing required argument). No task was run. | Caller's fault, not the task's. |

The load-bearing rule: **exit `0` is reserved for `proven` only.** A graceful
exit, a partial success, or "no work needed" never maps to `0`. This is what
keeps the promise *exit 0 ⇒ the delivery conditions were independently proven* and
prevents a run that quietly did nothing from looking green in CI.

This table is the contract for **both** `keystone task run` and `keystone ci`.
Nothing else may be returned by a finished task.

## `keystone ci` — the headless automation command

`keystone ci` is the one command a CI job or another agent drives unattended. It
is deliberately narrower than `keystone task run`:

- **Always non-interactive.** It never reads the terminal. When a decision is
  required that it cannot answer, it records the pending item and the task stops
  (exit `3`) instead of hanging the build.
- **Always machine-readable.** It prints exactly one stable JSON object on
  stdout; progress and warnings go to stderr. There is no `--json` flag — the
  JSON object *is* the interface.
- **Exports a redacted proof.** On completion it writes a `metadata_only` proof
  artifact and reports its path (and bytes, redaction mode, proof-graph hash) in
  the JSON. The artifact is a deterministic projection of the ledger, so
  re-exporting cannot change the verdict.

```bash
keystone ci --project <path> --request <text> [options]
```

Key flags (see `keystone ci --help` for the full list):

- `--project <path>` / `--request <text>` — required.
- `--write-path <glob>` — declare a writable path in the Autonomy Envelope
  (repeatable). With no write path, a write action stops at exit `3`.
- `--accept-contract` — proceed when the compiled contract is `awaiting_approval`.
  **Without it,** an unresolved contract exits `3` rather than guessing the task.
- `--scripted-fixture <file>` — offline, deterministic model for CI and tests
  (no network, no key).
- `--out <file>` — proof artifact path (default `./keystone-proof.json`,
  written `0600`).

It changes **no kernel semantics**: every state transition goes through
`KernelSession`, the proof is re-exported from the ledger, and redaction strips
file content while keeping hashes, statuses and references.

### Stable JSON result (v1)

Printed once on stdout. Field names are frozen; additions are new *optional*
keys.

```json
{
  "command": "keystone.ci",
  "resultVersion": 1,
  "taskId": "task_...",
  "status": "proven",
  "exitCode": 0,
  "outcome": "proven",
  "mode": "standard",
  "steps": 3,
  "changedPaths": ["src/auth/session.js"],
  "artifact": {
    "path": "/abs/keystone-proof.json",
    "bytes": 1234,
    "redaction": "metadata_only",
    "proofGraphHash": "..."
  },
  "conditions": [],
  "unverified": [],
  "residualRisks": [],
  "reproduceCommands": [],
  "reasons": [],
  "pendingInterventions": []
}
```

`artifact` is `null` when a proof could not be produced (e.g. no model was
configured, or the task stopped before a contract existed); `reasons` then
explains why. `exitCode` mirrors the process exit code so a consumer that only
parses stdout still sees the branch decision.

## Rejected alternatives

- **A distinct exit code for "graceful stop" vs "failure".** Both are
  non-delivered; the precise `status` is in the JSON, and collapsing them to
  `1` keeps one vocabulary across `task run` and `ci` without weakening the
  green/red line.
- **Auto-accepting the contract by default in `ci`.** That would guess the
  task on an `awaiting_approval` contract. It stays an explicit `--accept-contract`
  opt-in; otherwise the honest outcome is exit `3`.
