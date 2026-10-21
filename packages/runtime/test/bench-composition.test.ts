/**
 * Bench-composition smoke test (regression for the M1 scenario extraction).
 *
 * `runtime/bench/perf.ts` seeds tasks by creating a `KernelSession`, compiling a
 * contract, and starting the task. After ADR-0006 the kernel ships no engineering
 * policy, so that composition only works when the bench wires the engineering
 * seams (`ContractProposer` + `ActionCapabilityResolver`). This test reproduces
 * the bench's exact create→submit→compile→start sequence with those seams and
 * proves it reaches `executing`, and that dropping the proposer still fails
 * loudly (the kernel's guard must not be weakened just to make the bench pass).
 *
 * If the bench drifts (e.g. forgets to wire a seam), this is the check that fails
 * first against the current kernel + pack.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KernelError,
  KernelSession,
  defaultEnvelope,
  resolveKeystonePaths,
} from "@keystone/kernel";
import { compileContract, resolveEngineeringAction } from "@keystone/pack-engineering";
import {
  autonomyEnvelopeSchema,
  newId,
  nowIso,
  projectProfileSchema,
  type Budget,
  type ProjectId,
  type ProjectProfile,
} from "@keystone/schemas";

function benchProfile(projectId: ProjectId): ProjectProfile {
  const now = nowIso();
  // Built through the schema so the fixture cannot drift from the protocol.
  return projectProfileSchema.parse({
    projectId,
    rootPath: process.cwd(),
    name: "benchmark-fixture",
    vcs: "git",
    languages: ["typescript"],
    packageManager: "pnpm",
    support: { status: "supported", reasons: ["synthetic dataset for the performance baseline"] },
    commands: [
      { kind: "test", command: "pnpm run test", status: "identified", source: "package.json#scripts.test" },
    ],
    instructionFiles: [],
    createdAt: now,
    updatedAt: now,
  }) as ProjectProfile;
}

test("the bench's seeded composition reaches executing with the engineering seams wired", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-bench-comp-"));
  try {
    const paths = resolveKeystonePaths(home);
    const projectId = newId("proj") as ProjectId;
    const budget: Budget = { maxTokens: 1_000_000, maxWallClockMs: 3_600_000, maxRetries: 3 };

    // Mirrors runtime/bench/perf.ts seed(): wire the exact engineering seams.
    const session = await KernelSession.create({
      paths,
      projectId,
      request: "benchmark task 0",
      actorId: "bench",
      proposeContract: compileContract,
      resolveAction: resolveEngineeringAction,
    });
    await session.submit();
    await session.compile({
      profile: benchProfile(projectId),
      facts: [],
      autonomy: autonomyEnvelopeSchema.parse({
        ...defaultEnvelope(projectId as never, budget),
        writePaths: ["src/**"],
        allowedCommands: ["pnpm"],
        updatedAt: nowIso(),
        updatedBy: "user",
      }),
      budget,
    });
    await session.start();

    assert.equal(session.state().status, "executing");
    assert.ok(session.contract() !== undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a session seeded without the proposer still fails loudly (loud guard is not weakened)", async () => {
  const home = await mkdtemp(join(tmpdir(), "keystone-bench-comp-"));
  try {
    const paths = resolveKeystonePaths(home);
    const projectId = newId("proj") as ProjectId;
    const budget: Budget = { maxTokens: 1_000_000, maxWallClockMs: 3_600_000, maxRetries: 3 };

    // Deliberately omit the proposer, exactly the drift that broke the bench.
    const session = await KernelSession.create({
      paths,
      projectId,
      request: "benchmark task drift",
      actorId: "bench",
    });
    await session.submit();
    await assert.rejects(
      () =>
        session.compile({
          profile: benchProfile(projectId),
          autonomy: autonomyEnvelopeSchema.parse({
            ...defaultEnvelope(projectId as never, budget),
            writePaths: ["src/**"],
            allowedCommands: ["pnpm"],
            updatedAt: nowIso(),
            updatedBy: "user",
          }),
          budget,
        }),
      (error: unknown) => {
        assert.ok(error instanceof KernelError);
        assert.equal(error.code, "no_contract_proposer");
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
