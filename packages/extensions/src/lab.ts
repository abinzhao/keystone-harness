import { mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock, writeFileAtomic } from "@keystone/kernel";
import { contentHash, newId, nowIso, type ConformanceReport, type UserDecision } from "@keystone/schemas";
import type { ToolResult } from "@keystone/tools";
import { ExtensionLifecycleService } from "./service.ts";
import { LocalPackageError, type LocalProbeApproval } from "./manager.ts";
import { createTaskExtensionHost, type ExtensionLeaseExecutor } from "./task-host.ts";

export interface HarnessLabReport {
  readonly reportId: string;
  readonly at: string;
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly reviewHash: string;
  readonly conformance: ConformanceReport;
  readonly fixtureRun?: ToolResult;
  readonly limitations: readonly string[];
  readonly provenance: { readonly trustLevel: "untrusted"; readonly derivedFrom: readonly string[] };
  readonly reportHash: string;
}

export interface HarnessLabRunInput extends LocalProbeApproval {
  /** Supplied by the parent, never minted in the Lab. */
  readonly execute?: ExtensionLeaseExecutor;
  readonly activationDecision?: UserDecision;
}

/** Lab registry/project data is disposable; reports are local derived observations. */
export class HarnessLabService {
  private readonly directory: string;
  constructor(options: { readonly reportsDirectory: string }) {
    this.directory = options.reportsDirectory;
  }

  async run(directory: string, input: HarnessLabRunInput): Promise<HarnessLabReport> {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "keystone-harness-lab-")));
    const service = new ExtensionLifecycleService({ registryFile: join(workspace, "registry.json") });
    try {
      const reviewed = await service.review(directory);
      if (reviewed.reviewHash !== input.reviewHash) throw new LocalPackageError("Lab review hash changed");
      await service.install(directory, input.reviewHash, true);
      const probed = await service.probe(reviewed.read.manifest.name, input);
      let fixtureRun: ToolResult | undefined;
      const limitations = ["Process/Node permission isolation is not an OS or network sandbox.",
        "Extension reports are untrusted observations, not completion Evidence."];
      if (probed.conformance.passed && input.execute !== undefined) {
        await service.activate(reviewed.read.manifest.name, {
          reviewHash: input.reviewHash, ...(input.activationDecision === undefined ? {} : { decision: input.activationDecision }),
        });
        await writeFile(join(workspace, "README.txt"), "Keystone Harness Lab fixture\n", { mode: 0o600 });
        const host = createTaskExtensionHost({
          service, rootPath: workspace, resources: ["README.txt"],
          taskId: input.decision.taskId, branchId: input.decision.branchId,
          execute: input.execute, signal: input.signal,
        });
        try {
          const [tool] = await host.tools();
          const [verifier] = await host.verifiers();
          if (tool !== undefined) fixtureRun = await host.callTool(tool.descriptor.id, {});
          else if (verifier !== undefined) {
            const result = await verifier.run({ conditions: [], changedPaths: [] });
            fixtureRun = {
              status: result.status === "passed" ? "succeeded" : "failed", stdout: result.summary,
              outputBytes: result.outputBytes, durationMs: result.durationMs, changedPaths: [], truncated: result.truncated,
            };
          } else limitations.push("No supported read-only task entry; only conformance was executed.");
        } finally { await host.close(); }
      } else limitations.push("Fixture entry was not executed: missing parent lease executor or failed conformance.");
      const base = {
        reportId: newId("lab"), at: nowIso(), extensionName: reviewed.read.manifest.name,
        extensionVersion: reviewed.read.manifest.version, reviewHash: input.reviewHash,
        conformance: probed.conformance, ...(fixtureRun === undefined ? {} : { fixtureRun }),
        limitations, provenance: { trustLevel: "untrusted" as const, derivedFrom: [input.reviewHash, probed.conformance.reportHash] },
      };
      const report: HarnessLabReport = { ...base, reportHash: contentHash(base) };
      const serialized = JSON.stringify(report);
      if (Buffer.byteLength(serialized) > 256 * 1024) throw new LocalPackageError("Lab report exceeds byte limit");
      await withLock(join(this.directory, ".reports.lock"), { staleMs: Infinity }, async () => {
        const files = await readdir(this.directory);
        if (files.filter((name) => /^lab_[a-zA-Z0-9_-]+\.json$/.test(name)).length >= 128) {
          throw new LocalPackageError("Lab report count limit reached; no audit report was discarded");
        }
        await writeFileAtomic(join(this.directory, `${report.reportId}.json`), serialized);
      });
      return report;
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }

  async list(): Promise<readonly HarnessLabReport[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const reports: HarnessLabReport[] = [];
    for (const name of names.filter((name) => /^lab_[a-zA-Z0-9_-]+\.json$/.test(name)).sort()) {
      if (reports.length >= 128) throw new LocalPackageError("Lab report count limit exceeded");
      reports.push(JSON.parse(await this.export(name.slice(0, -5))) as HarnessLabReport);
    }
    return reports;
  }

  async export(reportId: string): Promise<string> {
    if (!/^lab_[a-zA-Z0-9_-]+$/.test(reportId)) throw new LocalPackageError("invalid Lab report id");
    const handle = await open(join(this.directory, `${reportId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) throw new LocalPackageError("Lab report exceeds byte limit");
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 256 * 1024) throw new LocalPackageError("Lab report exceeds byte limit");
      raw = buffer.subarray(0, size).toString("utf8");
    } finally { await handle.close(); }
    const parsed = JSON.parse(raw) as HarnessLabReport;
    const { reportHash, ...base } = parsed;
    if (parsed.reportId !== reportId || contentHash(base) !== reportHash) throw new LocalPackageError("Lab report integrity changed");
    return raw;
  }
}
