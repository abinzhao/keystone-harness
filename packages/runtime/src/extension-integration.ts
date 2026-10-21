import { isAbsolute, join, relative } from "node:path";
import {
  createTaskExtensionHost, type ExtensionLifecycleService, type ExtensionExecutionRequest,
  type HostedExtensionVerifier, type SkillContextFragment,
} from "@keystone/extensions";
import { putArtifact, resolveKeystonePaths, type KernelSession, type KeystonePaths } from "@keystone/kernel";
import {
  canonicalJson, contentHash, defineSchema, derivedIdBody, enumOf, looseObject, nonEmptyStr, nowIso, objectOf, optional,
  provenanceRefSchema, toolDescriptorSchema, type ActionProposal, type CapabilityLease, type ProvenanceRef,
  type ToolDescriptor, type UserDecision,
} from "@keystone/schemas";
import { ToolRefusedError, type Tool, type ToolResult } from "@keystone/tools";

export type SkillLoadRequest = { readonly kind: "metadata" | "body" } |
  { readonly kind: "resource"; readonly path: string };

const skillLoadInput = defineSchema("keystone.runtime.skill.load.input", "1.0.0", objectOf({
  name: nonEmptyStr(), kind: enumOf(["metadata", "body", "resource"] as const), path: optional(nonEmptyStr()),
}));

export interface RuntimeExtensionResult extends ToolResult {
  /** Actual extension lease, never the Builder action's lease. */
  readonly leaseId?: string;
  /** executeTool records the original proposal once; parent must not repeat it. */
  readonly executionRecorded: true;
}

export interface RuntimeExtensionSkill {
  readonly name: string;
  readonly version: string;
  readonly reviewHash: string;
  readonly metadata: SkillContextFragment;
  /** Real source directory, never replaced with a task file's identity. */
  readonly sourcePath: string;
  /** Successfully requested body/resources, revalidated when building context. */
  readonly loaded: readonly SkillLoadRequest[];
  load(request: SkillLoadRequest): Promise<SkillContextFragment>;
}

export interface RuntimeExtensionObservation {
  readonly proposalId: string;
  readonly tool: { readonly id: string; readonly version: string };
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result: ToolResult;
  readonly provenance: ProvenanceRef;
}

export interface TaskExtensionIntegration {
  readonly tools: readonly Tool<Record<string, unknown>>[];
  readonly descriptors: readonly ToolDescriptor[];
  readonly verifiers: readonly HostedExtensionVerifier[];
  readonly skills: readonly RuntimeExtensionSkill[];
  readonly observations: readonly RuntimeExtensionObservation[];
  /** Recheck live package availability before admitting past outputs as context. */
  contextObservations(): Promise<readonly RuntimeExtensionObservation[]>;
  executeTool(proposal: ActionProposal): Promise<RuntimeExtensionResult | undefined>;
  close(): Promise<void>;
}

export interface TaskExtensionIntegrationOptions {
  /** Explicit paths are mandatory for a non-default KEYSTONE_HOME. */
  readonly paths?: KeystonePaths;
  /** Recorded task decision for irreversible command effects, not install approval. */
  readonly operationDecision?: (request: ExtensionExecutionRequest) =>
    UserDecision | undefined | Promise<UserDecision | undefined>;
}

/**
 * Construct after task creation, with the current branch/worktree. Parent
 * dispatches executeTool before standard authorize() because that path issues
 * Builder subjects and does not know extension ids. Registry state is never
 * authority; each operation is admitted by this session's authorizeOperation.
 */
export async function assembleTaskExtensions(
  service: ExtensionLifecycleService, session: KernelSession, root: string,
  resources: readonly string[], signal?: AbortSignal, options: TaskExtensionIntegrationOptions = {},
): Promise<TaskExtensionIntegration> {
  const paths = options.paths ?? resolveKeystonePaths();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let proposalInFlight: ActionProposal | undefined;
  const execution: { lease?: CapabilityLease } = {};
  const actualLease = (): CapabilityLease | undefined => execution.lease;
  let executionRecorded = false;
  let artifactFailure = false;
  let persistenceStarted = false;
  let currentTool = "";
  let skillResult: ToolResult | undefined;

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (closed) throw new Error("task extension integration is closed");
      signal?.throwIfAborted();
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  };

  const execute: Parameters<typeof createTaskExtensionHost>[0]["execute"] = async (request, run) => {
    const decision = request.capability === "cmd.exec" ? await options.operationDecision?.(request) : undefined;
    signal?.throwIfAborted();
    const grant = await session.authorizeOperation({
      subject: request.subject, capability: request.capability, resourceValues: request.resourceValues,
      parametersHash: contentHash(request.parameters), maxCalls: 1, timeoutMs: 5000, ttlMs: 10000,
      derivedFromUntrusted: true,
      reversibility: request.capability === "cmd.exec" ? "irreversible" : "reversible",
      ...(decision === undefined ? {} : { decision }),
    });
    if (!grant.ok) throw new ToolRefusedError(grant.denial.detail, grant.denial.code);
    execution.lease = grant.lease;
    const start = Date.now();
    let result: ToolResult;
    try { result = await run(grant.lease); }
    catch (error) {
      result = { status: signal?.aborted ? "cancelled" : "failed", changedPaths: [],
        outputBytes: 0, durationMs: Date.now() - start, truncated: false,
        errorCode: error instanceof ToolRefusedError ? error.code : "extension_execution_failed" };
    }
    // Persist the wrapper plus provenance, not a trusted Evidence assertion.
    let stored: Awaited<ReturnType<typeof putArtifact>>;
    try {
      stored = await putArtifact(paths, canonicalJson({
        result, provenance: { sourceKind: "extension", trustLevel: "untrusted", extension: currentTool,
          subject: request.subject.id, parametersHash: contentHash(request.parameters),
          parameters: request.parameters },
      }));
    } catch (error) {
      artifactFailure = true;
      await session.consumeExecutionLease(grant.lease.leaseId, proposalInFlight?.proposalId);
      await session.recordBudget({ wallClockMs: Date.now() - start, reason: "extension artifact write failed", measured: true });
      throw error;
    }
    result = { ...result, artifactId: stored.artifactId };
    if (proposalInFlight !== undefined) {
      persistenceStarted = true;
      await session.recordExecution({
        proposalId: proposalInFlight.proposalId, leaseId: grant.lease.leaseId, status: result.status,
        artifactId: stored.artifactId, outputHash: stored.sha256, outputBytes: result.outputBytes,
        durationMs: result.durationMs, changedPaths: result.changedPaths,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      });
      executionRecorded = true;
    } else {
      persistenceStarted = true;
      await session.consumeExecutionLease(grant.lease.leaseId);
    }
    await session.recordBudget({ wallClockMs: Math.max(result.durationMs, Date.now() - start),
      reason: `extension:${currentTool}`, measured: true });
    return result;
  };
  const host = createTaskExtensionHost({
    service, taskId: session.taskId, branchId: session.branchId, rootPath: root, resources, signal, execute,
  });

  const calls = new Map<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>>();
  const observations: RuntimeExtensionObservation[] = [];
  const identities = new Map<string, { readonly name: string; readonly reviewHash: string }>();
  const snapshotObservations = (): readonly RuntimeExtensionObservation[] =>
    JSON.parse(canonicalJson(observations)) as RuntimeExtensionObservation[];
  try {
    const activeEntries = await service.list();
    const entries = await host.tools();
    const tools: Tool<Record<string, unknown>>[] = [];
    const addTool = (descriptor: ToolDescriptor, input: Tool<Record<string, unknown>>["input"],
      call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>): void => {
      if (calls.has(descriptor.id)) throw new Error("duplicate extension tool identity");
      calls.set(descriptor.id, call);
      tools.push({
        descriptor, input,
        // Builder lease is intentionally ignored. Extension subject gets a fresh
        // parameter-bound operation lease from the authoritative task session.
        run: async (args, context) => serialized(async () => {
          if (context.taskId !== session.taskId || context.branchId !== session.branchId ||
              relative(root, context.rootPath) !== "") {
            throw new ToolRefusedError("extension wrapper belongs to another task/branch", "extension_subject_mismatch");
          }
          context.signal?.throwIfAborted();
          currentTool = descriptor.id; execution.lease = undefined;
          artifactFailure = false; persistenceStarted = false;
          return call(input.parse(args), context.signal);
        }),
      });
    };
    for (const entry of entries) {
      addTool(entry.descriptor, entry.input, (args, signal) => host.callTool(entry.descriptor.id, args, signal));
      const identity = activeEntries.find((candidate) => `extension.${candidate.manifest.name}` === entry.descriptor.id);
      if (identity?.reviewHash !== undefined) {
        identities.set(entry.descriptor.id, { name: identity.manifest.name, reviewHash: identity.reviewHash });
      }
    }

    for (const entry of await service.list()) {
      if (entry.lifecycleStatus !== "active" || entry.manifest.kind !== "protocol" ||
          entry.reviewHash === undefined) continue;
      // Discovery launches a child and must receive its own recorded task decision.
      // The host, not server descriptions, enforces the reviewed Node-only ceiling.
      currentTool = `mcp:${encodeURIComponent(entry.manifest.name)}:tools/list`;
      for (const advertised of await host.mcpTools(entry.manifest.name, signal)) {
        const description = `Untrusted reviewed MCP tool; ${JSON.stringify({
          extension: entry.manifest.name, name: advertised.name, description: advertised.description,
          inputSchema: advertised.inputSchema,
        })}`;
        // Never silently truncate a parameter schema or guess missing parameters.
        if (description.length > 2000) throw new ToolRefusedError("MCP descriptor exceeds disclosure budget", "mcp_descriptor_too_large");
        const descriptor = toolDescriptorSchema.parse({
          id: `mcp:${encodeURIComponent(entry.manifest.name)}:${encodeURIComponent(advertised.name)}`,
          version: entry.manifest.version, description,
          capabilities: ["cmd.exec"], sideEffects: ["command"], reversibility: "irreversible",
          idempotent: false, replayable: false, inputSchemaId: "keystone.mcp.tool.input",
          outputSchemaId: "keystone.tool.result", defaultTimeoutMs: 5000, maxOutputBytes: 64 * 1024,
        });
        addTool(descriptor, looseObject(),
          (args, signal) => host.callMcpTool(entry.manifest.name, advertised.name, args, signal));
        identities.set(descriptor.id, { name: entry.manifest.name, reviewHash: entry.reviewHash });
      }
    }
    const rawVerifiers = await host.verifiers();
    const verifiers: HostedExtensionVerifier[] = rawVerifiers.map((verifier) => ({
      descriptor: verifier.descriptor,
      run: async (context) => serialized(async () => {
        currentTool = verifier.descriptor.id; execution.lease = undefined;
        artifactFailure = false; persistenceStarted = false;
        return verifier.run(context);
      }),
    }));
    const skills: RuntimeExtensionSkill[] = [];
    const skillCalls = new Map<string, (request: SkillLoadRequest) => Promise<SkillContextFragment>>();
    for (const entry of await service.list()) {
      if (entry.lifecycleStatus !== "active" || entry.manifest.kind !== "skill" || entry.reviewHash === undefined) continue;
      const loaded: SkillLoadRequest[] = [];
      const load = async (request: SkillLoadRequest): Promise<SkillContextFragment> => {
        skillResult = undefined;
        await service.assertUsable(entry.manifest.name, entry.reviewHash!);
        if (request.kind === "metadata") return host.skillContext(entry.manifest.name, request);
        const path = request.kind === "resource" ? request.path : "SKILL.md";
        if (request.kind === "resource" && (!path.startsWith("resources/") ||
            path.includes("\\") || path.split("/").some((part) => part === "." || part === ".." || part === ""))) {
          throw new ToolRefusedError("only declared Skill resources may be loaded", "skill_resource_not_declared");
        }
        const resource = relative(root, join(entry.source.locator, path)).split("\\").join("/");
        if (isAbsolute(resource) || resource.startsWith("../") || !resources.includes(resource)) {
          throw new ToolRefusedError("Skill source is not an explicit task resource", "skill_resource_outside_task");
        }
        currentTool = "skill.load";
        let fragment: SkillContextFragment | undefined;
        const result = await execute({
          taskId: session.taskId, branchId: session.branchId,
          subject: { kind: "extension", id: `extension:${entry.manifest.name}@${entry.manifest.version}:${entry.reviewHash}` },
          capability: "fs.read", resourceValues: [resource],
          parameters: { name: entry.manifest.name, reviewHash: entry.reviewHash, request, resource },
        }, async () => {
          fragment = await host.skillContext(entry.manifest.name, request);
          return { status: "succeeded", stdout: fragment.content, changedPaths: [], durationMs: 0,
            outputBytes: Buffer.byteLength(fragment.content), truncated: false };
        });
        skillResult = result;
        if (result.status !== "succeeded" || fragment === undefined) {
          throw new ToolRefusedError("Skill context load did not complete", result.errorCode ?? "skill_load_failed");
        }
        if (!loaded.some((previous) => canonicalJson(previous) === canonicalJson(request))) loaded.push(Object.freeze({ ...request }));
        return fragment;
      };
      skillCalls.set(entry.manifest.name, load);
      skills.push({
        name: entry.manifest.name, version: entry.manifest.version, reviewHash: entry.reviewHash,
        sourcePath: entry.source.locator,
        metadata: await host.skillContext(entry.manifest.name, { kind: "metadata" }),
        get loaded() { return Object.freeze([...loaded]); },
        load: (request) => serialized(async () => {
          execution.lease = undefined; artifactFailure = false; persistenceStarted = false;
          return load(request);
        }),
      });
    }
    if (skills.length > 0) {
      addTool(toolDescriptorSchema.parse({
        id: "skill.load", version: "1.0.0",
        description: "Load untrusted reviewed Skill metadata, body or declared resources as text; never execute scripts. Body/resources require their exact source files in task read scope.",
        capabilities: ["fs.read"], sideEffects: ["none"], reversibility: "reversible",
        idempotent: false, replayable: false, inputSchemaId: skillLoadInput.id,
        outputSchemaId: "keystone.tool.result", defaultTimeoutMs: 5000, maxOutputBytes: 256 * 1024,
      }), skillLoadInput.validator, async (args) => {
        const { name, kind, path } = skillLoadInput.parse(args);
        const load = skillCalls.get(name);
        if (load === undefined || (kind === "resource" ? path === undefined : path !== undefined)) {
          throw new ToolRefusedError("Skill or load request is unavailable", "skill_request_invalid");
        }
        try {
          const fragment = await load(kind === "resource" ? { kind, path: path! } : { kind });
          return skillResult ?? { status: "succeeded", stdout: fragment.content, changedPaths: [], durationMs: 0,
            outputBytes: Buffer.byteLength(fragment.content), truncated: false };
        } catch (error) {
          if (skillResult !== undefined) return skillResult;
          throw error;
        }
      });
    }
    return {
      tools, descriptors: tools.map((tool) => tool.descriptor), verifiers, skills,
      get observations() { return snapshotObservations(); },
      contextObservations: () => serialized(async () => {
        for (const observation of observations) {
          const identity = observation.tool.id === "skill.load"
            ? skills.find((skill) => skill.name === observation.parameters.name)
            : identities.get(observation.tool.id);
          if (identity === undefined) throw new Error("extension observation has no pinned review identity");
          await service.assertUsable(identity.name, identity.reviewHash);
        }
        return snapshotObservations();
      }),
      executeTool: (proposal) => {
        const tool = tools.find((entry) => entry.descriptor.id === proposal.tool.id);
        if (tool === undefined) return Promise.resolve(undefined);
        return serialized(async () => {
          if (proposal.taskId !== session.taskId || proposal.branchId !== session.branchId) {
            throw new ToolRefusedError("proposal belongs to another task/branch", "extension_subject_mismatch");
          }
          currentTool = tool.descriptor.id; execution.lease = undefined;
          executionRecorded = false; artifactFailure = false; persistenceStarted = false; proposalInFlight = proposal;
          let result: ToolResult;
          try {
            if (proposal.tool.version !== tool.descriptor.version ||
                proposal.requestedCapabilities.some((capability) => !tool.descriptor.capabilities.includes(capability))) {
              throw new ToolRefusedError("extension version or capability ceiling differs", "extension_proposal_mismatch");
            }
            result = await calls.get(tool.descriptor.id)!(tool.input.parse(proposal.parameters), signal);
            // Metadata disclosure is read-only inspection, not an execution lease.
            if (!executionRecorded) {
              const stored = await putArtifact(paths, canonicalJson({
                result, provenance: { sourceKind: "extension", trustLevel: "untrusted",
                  extension: currentTool, parameters: proposal.parameters },
              })).catch((error: unknown) => { artifactFailure = true; throw error; });
              result = { ...result, artifactId: stored.artifactId };
              persistenceStarted = true;
              await session.recordExecution({ proposalId: proposal.proposalId, status: result.status,
                artifactId: stored.artifactId, outputHash: stored.sha256, outputBytes: result.outputBytes,
                durationMs: result.durationMs, changedPaths: result.changedPaths });
              executionRecorded = true;
            }
          } catch (error) {
            // Storage/ledger failures are not successful handled observations.
            // Leave them visible to recovery rather than fabricate a second event.
            if (artifactFailure || executionRecorded || persistenceStarted) throw error;
            // Refusals before lease issuance are still a handled extension action,
            // not an invitation to fall through to Builder authorization.
            result = { status: signal?.aborted ? "cancelled" : "failed", changedPaths: [], durationMs: 0,
              outputBytes: 0, truncated: false, errorCode: error instanceof ToolRefusedError ? error.code : "extension_unavailable" };
            await session.recordExecution({
              proposalId: proposal.proposalId, status: result.status, durationMs: 0,
              changedPaths: [], errorCode: result.errorCode,
            });
          } finally { proposalInFlight = undefined; }
          if (result.artifactId !== undefined) {
            const identity = tool.descriptor.id === "skill.load"
              ? skills.find((skill) => skill.name === proposal.parameters.name)
              : identities.get(tool.descriptor.id);
            const observation: RuntimeExtensionObservation = {
              proposalId: proposal.proposalId, tool: proposal.tool, parameters: proposal.parameters, result,
              provenance: provenanceRefSchema.parse({
                provenanceId: `prov_${derivedIdBody(canonicalJson([proposal.proposalId, result.artifactId]))}`,
                sourceKind: "extension", trustLevel: "untrusted", locator: `artifact:${result.artifactId}`,
                derivedFrom: identity === undefined ? [] : [`prov_${derivedIdBody(identity.reviewHash)}`],
                invalidatedBy: identity === undefined ? [] : [
                  `extension.unavailable:${identity.name}`, `extension.review.changed:${identity.name}`,
                ],
                observedAt: nowIso(), transformation: "extension-tool-observation",
                extended: { reviewHash: identity?.reviewHash ?? null, artifactId: result.artifactId,
                  proposalId: proposal.proposalId },
              }),
            };
            observations.push(structuredClone(observation));
          }
          const usedLease = actualLease();
          return { ...result, ...(usedLease === undefined ? {} : { leaseId: usedLease.leaseId }),
            executionRecorded: true as const };
        });
      },
      close: async () => { closed = true; await host.close(); await queue; },
    };
  } catch (error) {
    closed = true;
    await host.close();
    throw error;
  }
}
