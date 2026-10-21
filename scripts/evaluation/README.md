# Local Evaluation And Release Gates

## Evaluation

`harness.ts` exports `EVALUATION_SUITE`, `evaluationFingerprint()` and
`runEvaluation({repetitions?, onTemporaryRoot?})`. The default is two repetitions;
the permitted range is 2-10. Both modes receive the same `scripted-1` descriptor,
response sequence and settings. Minimal intentionally makes no model calls.

Six `keystone.evaluation/1` scenarios cover a correct fix, an unsupported
completion claim, a refused scope escape, bounded repair, a zero-token budget
and checkpoint continuation. Each trial creates a fresh local Git repository,
Keystone store and separate acceptance file under the OS temporary directory.
All temporary state is removed, including when a trial fails.

The agent may write `src/**` only. Protected project checks and an acceptance
process outside the task workspace must both pass. Independent acceptance uses
varied inputs unavailable in the project tests; it runs an explicit Node test
file and requires four discovered tests. Child processes receive a minimal
environment without credentials or nested `NODE_TEST_CONTEXT`.

Completion requires kernel `proven`, proof `proven`, independent acceptance,
unchanged checks, scope integrity and consistent replay. Failure classifications,
actual model calls, ledger/proof hashes, elapsed time, event-derived budgets and
checkpoint outcomes remain available per trial. Write counts correlate
`action.executed` with `fs.write_file` proposals, excluding verifier executions.
Model/provider tokens are reported as zero by the scripted adapter, not inferred.
Kernel-charged wall time and total elapsed time are distinct fields.

The input fingerprint covers fixture content, checks, settings and descriptor.
The scorecard separately records the source commit, dirty flag, digest of
relevant source files, Node/platform/architecture and non-deterministic fields.
Source binding is collected at suite start; reproducibility requires a quiescent
source tree throughout the run. A fingerprint is not a promise of identical
timings, generated IDs or event hashes.

```sh
node --test scripts/evaluation/test/harness.test.ts
node scripts/evaluation/harness.ts --repetitions 2
node scripts/evaluation/harness.ts --repetitions 2 --out dist/evaluation/scorecard.json
```

Without `--out`, the scorecard goes to stdout. Explicit output creates a new file
and refuses overwrite. The command exits nonzero for false completion, scope
escape, inconsistent replay or an infrastructure failure. Per-trial recovery
results and intentional task failures must also be reviewed; completion rate
alone is not an acceptance gate.

Measured continuation creates a new runtime around the same persisted task and
calls `resumeTask(taskId)`. It is **not** a forced subprocess-crash test. Real
provider quality, provider cost, crash recovery, production workload breadth and
statistical significance remain explicitly missing. No public models, hosted
services, installation or deployment are used.

## Release Readiness

`../release/readiness.ts` exports `checkReleaseReadiness(input, options)`,
`LOCAL_GATES`, `STABLE_GATES`, input/evidence types and `ReadinessScorecard`.
A parent server may project the returned value at `GET /v1/release/readiness`.
This checker does not change the existing `version-check.ts` RC policy and does
not authorize any publication.

```ts
const scorecard = await checkReleaseReadiness(input, {
  root: evidenceDirectory,
  // Optional defaults: current time, evidence age <= 7 days.
  now: new Date(),
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});
```

Input shape:

```json
{
  "version": "keystone.release-readiness/1",
  "releaseVersion": "1.0.0-rc.1",
  "sourceCommit": "<40-or-64-hex-commit>",
  "sourceDigest": "<64-hex-source-tree-digest>",
  "artifactDigest": "<64-hex-release-artifact-digest>",
  "gates": [
    {
      "gateId": "tests",
      "status": "passed",
      "evidence": {
        "path": "artifacts/<64-hex-sha256>.json",
        "sha256": "<64-hex-sha256>"
      }
    }
  ]
}
```

The evidence document uses `version: "keystone.release-evidence/1"`, the same
four release/source/artifact fields, `gateId`, `status`, ISO `observedAt` and
`details`. Digest is SHA-256 of file bytes, not a reconstructed object.
Evidence must be a regular, nonsymlink file under the configured root, no larger
than 1 MiB, addressed as `artifacts/<sha256>.json`. Missing evidence cannot
support `passed`. Future, stale, mismatched, duplicate, unknown or tampered claims
are rejected or classified invalid. Explicit failure/blocking is never upgraded.

Local gates: `typecheck`, `tests`, `conformance`, `offline_smoke`, `release_check`,
`evaluation`. Command evidence details are
`{command: string[], exitCode: 0, checks: positiveInteger, failures: 0}`.
Evaluation details are
`{suiteVersion: "keystone.evaluation/1", repetitions: >=2, modes: ["minimal","standard"], inputFingerprint, runs, falseCompletions: 0, scopeEscapes: 0, infrastructureFailures: 0, replayInconsistent: 0, missingMetrics: string[]}`.
The evidence producer must derive these values from the actual scorecard, not
invent successful summaries.

Stable additionally requires `source_clean`, `macos_universal`, `embedded_node`,
`macos_signing`, `notarization`, `live_provider`, `windows`, `hosted_ci` and
`release_approval`. Gate-specific details are checked in `gatePassed()`:
matching clean source, both architectures and native launch, self-contained Node,
non-ad-hoc Developer ID/team verification, accepted and stapled notarization,
non-scripted network provider acceptance with usage, native Windows launch,
hosted HTTPS CI run bound to the commit, and an explicit local user decision.
An RC never has `stableReady: true`, even if supplied gates pass.

```sh
node --test scripts/release/test/readiness.test.ts
node scripts/release/readiness.ts --input /absolute/evidence-directory/readiness-input.json
```

The CLI prints JSON and exits nonzero when the applicable local RC or stable
gates are unmet. It never calls signing/notarization/CI/provider services.

Hash integrity and matching fields do not independently authenticate report
producers. Protect the local admission path and evidence storage. Synthetic
fixtures in readiness tests establish validation behavior, not actual external
release success. No evidence for those external gates is supplied by this module.
