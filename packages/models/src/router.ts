/**
 * Model routing.
 *
 * Routing is the *only* thing that changes when the user switches models. It
 * holds no task state and can therefore never alter a task's goal, permissions,
 * status or completion conditions — which is the promise made in PRD ST-01 and
 * NFR-REL-04. The router is also the place that records where data would go, so
 * the UI can show the destination before a call is made (PRD 11.4).
 */

import {
  ModelCapabilityUnsatisfiedError,
  ModelContentInvalidError,
  ModelContentUnsupportedError,
  ModelToolsUnsupportedError,
  ModelProtocolError,
  ModelUnavailableError,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelRequest,
  type ModelResponse,
  type ModelRole,
} from "./types.ts";
import { assertModelContent, requestHasImages } from "./content.ts";

/** Roles exist so a cheap model can summarise while an expensive one plans. */
export const MODEL_ROLES: readonly ModelRole[] = ["builder", "summarizer", "planner"];

export interface RouteAttempt {
  readonly role: ModelRole;
  readonly modelId: string;
  readonly outcome: "ok" | "unavailable" | "protocol_error";
  readonly detail?: string;
}

export interface RouteOutcome {
  readonly response: ModelResponse;
  readonly modelId: string;
  readonly attempts: readonly RouteAttempt[];
}

export interface ModelAttemptHooks {
  readonly beforeAttempt?: (descriptor: ModelDescriptor) => Promise<void>;
  readonly afterAttempt?: (
    descriptor: ModelDescriptor, response: ModelResponse | undefined, error?: unknown,
  ) => Promise<void>;
}

export interface EgressDescription {
  readonly role: ModelRole;
  readonly modelId: string;
  readonly provider: string;
  readonly endpointHost: string;
  readonly protocol: string;
  readonly local: boolean;
  readonly dataClasses: readonly string[];
  readonly nativeTools: boolean;
  readonly structuredOutput: boolean;
  readonly multimodal: boolean;
  readonly credentialHandle?: string;
}

export class ModelRouter {
  private readonly adapters = new Map<string, ModelAdapter>();
  private readonly order: string[] = [];
  private readonly routes = new Map<ModelRole, string[]>();

  register(adapter: ModelAdapter): void {
    if (!this.adapters.has(adapter.descriptor.id)) this.order.push(adapter.descriptor.id);
    this.adapters.set(adapter.descriptor.id, adapter);
  }

  /** Set the fallback order for a role. Unregistered ids are ignored, not invented. */
  setRoute(role: ModelRole, modelIds: readonly string[]): void {
    this.routes.set(
      role,
      modelIds.filter((id) => this.adapters.has(id)),
    );
  }

  /**
   * Switching the model for a role. There is intentionally no task argument:
   * a model switch cannot be allowed to reach task state.
   */
  switchModel(role: ModelRole, modelId: string): void {
    if (!this.adapters.has(modelId)) {
      throw new Error(`model "${modelId}" is not registered`);
    }
    const existing = this.routes.get(role) ?? [];
    this.routes.set(role, [modelId, ...existing.filter((id) => id !== modelId)]);
  }

  route(role: ModelRole): readonly ModelAdapter[] {
    const configured = this.routes.get(role) ?? [];
    const ids = configured.length > 0 ? configured : this.order;
    return ids
      .map((id) => this.adapters.get(id))
      .filter((adapter): adapter is ModelAdapter => adapter !== undefined);
  }

  listModels(): readonly ModelDescriptor[] {
    return this.order
      .map((id) => this.adapters.get(id)?.descriptor)
      .filter((descriptor): descriptor is ModelDescriptor => descriptor !== undefined);
  }

  /** Registered adapters, including models outside every configured route. */
  listAdapters(): readonly ModelAdapter[] {
    return this.order.map((id) => this.adapters.get(id)!);
  }

  /** Copy registration/routes; adapter closures and their credential handles remain task-local. */
  snapshot(): ModelRouter {
    const snapshot = new ModelRouter();
    for (const id of this.order) {
      const adapter = this.adapters.get(id)!;
      const descriptor = structuredClone(adapter.descriptor);
      Object.freeze(descriptor.capabilities);
      Object.freeze(descriptor.dataEgress.classes);
      Object.freeze(descriptor.dataEgress);
      Object.freeze(descriptor);
      const transportPermission = adapter.transportPermission === undefined
        ? undefined : structuredClone(adapter.transportPermission);
      if (transportPermission !== undefined) {
        Object.freeze(transportPermission.argvPrefix);
        Object.freeze(transportPermission);
      }
      snapshot.register({
        descriptor, complete: adapter.complete.bind(adapter),
        ...(adapter.configurationDigest === undefined ? {} : { configurationDigest: adapter.configurationDigest }),
        ...(transportPermission === undefined ? {} : { transportPermission }),
      });
    }
    for (const [role, ids] of this.routes) snapshot.setRoute(role, ids);
    return snapshot;
  }

  /**
   * Where a role's traffic currently goes. Shown to the user before work starts,
   * because "local-first" must not be used to hide real outbound traffic
   * (PRD 11.4).
   */
  describeEgress(): readonly EgressDescription[] {
    return MODEL_ROLES.map((role) => {
      const primary = this.route(role)[0]?.descriptor;
      return {
        role,
        modelId: primary?.id ?? "(none configured)",
        provider: primary?.provider ?? "(none)",
        endpointHost: primary?.endpointHost ?? "(none)",
        protocol: primary?.protocol ?? "(none)",
        local: primary?.dataEgress.local ?? true,
        dataClasses: primary?.dataEgress.classes ?? [],
        nativeTools: primary?.capabilities.nativeTools ?? false,
        structuredOutput: primary?.capabilities.structuredOutput ?? false,
        multimodal: primary?.capabilities.multimodal ?? false,
        ...(primary?.credentialHandle === undefined
          ? {}
          : { credentialHandle: primary.credentialHandle }),
      };
    });
  }

  /**
   * Adapters on the route that can satisfy what this request actually asks for
   * (ADR-0010 §3). Today the one hard-filtered capability is native tool calling:
   * a request carrying tool descriptors must not be routed to an adapter that would
   * silently drop them.
   */
  private routeSatisfying(role: ModelRole, request: ModelRequest): readonly ModelAdapter[] {
    const needNativeTools = request.tools.length > 0;
    const needImages = requestHasImages(request);
    const route = this.route(role);
    const primary = route[0]?.descriptor;
    return route.filter(({ descriptor }) => {
      if (needNativeTools && !descriptor.capabilities.nativeTools) return false;
      if (needImages && !descriptor.capabilities.multimodal) return false;
      if (primary === undefined) return false;
      // Capability filtering must not silently turn a local request into egress.
      if (primary.dataEgress.local) return descriptor.dataEgress.local;
      return descriptor.dataEgress.local ||
        (descriptor.endpointHost === primary.endpointHost &&
          descriptor.dataEgress.classes.every((value) => primary.dataEgress.classes.includes(value)));
    });
  }

  async complete(role: ModelRole, request: ModelRequest, hooks: ModelAttemptHooks = {}): Promise<RouteOutcome> {
    const all = this.route(role);
    const attempts: RouteAttempt[] = [];

    if (all.length === 0) {
      throw new ModelUnavailableError(
        "(none)",
        `no model is configured for the "${role}" role; configure a model before running tasks`,
        false,
      );
    }

    const candidates = this.routeSatisfying(role, request);
    if (candidates.length === 0) {
      // Loud refusal, before any network call: do not pick a text-envelope adapter
      // that would discard the tool descriptors.
      throw new ModelCapabilityUnsatisfiedError(
        role,
        requestHasImages(request) ? "multimodal" : "native_tools",
        `the request carries ${request.tools.length} tool descriptor(s), but every model on the ` +
          `"${role}" route is a text-envelope adapter. Add a native-tools model (openai-responses, ` +
          `anthropic-messages or gemini-generate) or describe the tools in the prompt instead.`,
      );
    }

    let lastError: Error | undefined;
    for (const adapter of candidates) {
      assertModelContent(adapter.descriptor, request);
      // Controller refusals must not enter the adapter-error fallback path.
      await hooks.beforeAttempt?.(adapter.descriptor);
      let response: ModelResponse | undefined;
      let failure: unknown;
      let failed = false;
      try {
        response = await adapter.complete({ ...request, role });
      } catch (error) { failed = true; failure = error; }
      await hooks.afterAttempt?.(adapter.descriptor, response, failed ? failure : undefined);
      if (!failed) {
        attempts.push({ role, modelId: adapter.descriptor.id, outcome: "ok" });
        return { response: response!, modelId: adapter.descriptor.id, attempts };
      } else {
        const error = failure;
        if (error instanceof ModelContentUnsupportedError || error instanceof ModelContentInvalidError ||
            error instanceof ModelToolsUnsupportedError || request.signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof ModelProtocolError) {
          attempts.push({ role, modelId: adapter.descriptor.id, outcome: "protocol_error", detail });
        } else {
          attempts.push({ role, modelId: adapter.descriptor.id, outcome: "unavailable", detail });
        }
        lastError = error instanceof Error ? error : new Error(detail);
      }
    }

    if (lastError instanceof ModelUnavailableError || lastError instanceof ModelProtocolError) {
      // Surface the last failure but keep the whole attempt list available, so
      // the UI can explain what was tried rather than just that it failed.
      const enriched = Object.assign(lastError, { attempts });
      throw enriched;
    }
    throw new ModelUnavailableError("(all)", lastError?.message ?? "every configured model failed", false);
  }
}
