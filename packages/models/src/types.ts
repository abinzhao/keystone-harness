/**
 * Model adapter boundary.
 *
 * The adapter layer exists to keep one promise: **switching or losing a model
 * never changes the task's goal, permissions, status or completion conditions**
 * (PRD ST-01, NFR-REL-04). So adapters are deliberately dumb — text in,
 * text plus usage out. They hold no task state, no authority, and never see a
 * long-lived credential: they receive a resolver and ask for a handle.
 */

import type { ModelDescriptor, ToolDescriptor } from "@keystone/schemas";

// Re-exported so adapter implementations can name descriptor types without also
// depending on the schema package directly.
export type { ModelDescriptor, ToolDescriptor };

export type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
      /** Raw base64, never a path or remote URL. */
      readonly data: string;
      readonly artifactId?: string;
      readonly sourceId?: string;
    };

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly ModelContentPart[];
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  /** Tools the model may choose from. Descriptors only — no implementations. */
  readonly tools: readonly ToolDescriptor[];
  readonly jsonMode: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Free-form label used for cost attribution in the proof package. */
  readonly role?: ModelRole;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A provider-native tool call, mapped to Keystone's neutral shape. The adapter
 * only *maps* it; it never executes the tool — execution stays behind the
 * Capability Lease (AGENTS.md §2 I3). `id` is the provider call id (or one we
 * synthesised), `name` the tool id the caller registered, `args` the parsed JSON.
 */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelResponse {
  /** Free-text answer. Empty when the model's only output was tool calls. */
  readonly text: string;
  /** Structured tool calls the model requested; empty when it answered in prose. */
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: ModelUsage;
  readonly modelName: string;
  readonly finishReason: string;
}

export type ModelRole = "builder" | "summarizer" | "planner";

/** The wire protocol an adapter speaks. See ADR-0010 §2. */
export type ModelProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate";

export interface ModelAdapter {
  readonly descriptor: ModelDescriptor;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Resolves a credential *handle* to a secret at the moment of use. The secret
 * never appears in the descriptor, the config file, an event, or a log
 * (PRD 11.3, 11.4).
 */
export interface CredentialResolver {
  resolve(handle: string): Promise<string | undefined>;
}

export class ModelUnavailableError extends Error {
  readonly modelId: string;
  readonly retriable: boolean;
  constructor(modelId: string, message: string, retriable = true) {
    super(message);
    this.name = "ModelUnavailableError";
    this.modelId = modelId;
    this.retriable = retriable;
  }
}

/** The provider answered, but not in a shape the protocol can consume. */
export class ModelProtocolError extends Error {
  readonly modelId: string;
  constructor(modelId: string, message: string) {
    super(message);
    this.name = "ModelProtocolError";
    this.modelId = modelId;
  }
}

export class ModelContentUnsupportedError extends Error {
  readonly modelId: string;
  constructor(modelId: string, detail: string) {
    super(`model "${modelId}" cannot accept this content: ${detail}`);
    this.name = "ModelContentUnsupportedError";
    this.modelId = modelId;
  }
}

export class ModelContentInvalidError extends Error {
  constructor() {
    // Do not echo rejected content: it can contain bytes, paths or secrets.
    super("model content must contain text or PNG/JPEG/WebP with canonical raw base64");
    this.name = "ModelContentInvalidError";
  }
}

/**
 * The caller asked for native tool calling (`ModelRequest.tools`), but this
 * adapter only speaks a text envelope.
 *
 * Thrown *before* any network call on purpose: silently dropping the tool
 * descriptions would send the model a prompt it can act on while the caller
 * believes structured tool calls are negotiated, which is the worst kind of
 * silent contract drift. This is a permanent configuration mismatch, not a
 * transient provider fault, so it is not retriable and the router must not
 * treat it as "the model is unavailable".
 */
export class ModelToolsUnsupportedError extends Error {
  readonly modelId: string;
  readonly toolCount: number;
  constructor(modelId: string, toolCount: number) {
    super(
      `model "${modelId}" cannot use native tool calling: the request carries ${toolCount} tool ` +
        "descriptor(s), but this adapter only sends a plain-text envelope. Describe the tools in the " +
        "prompt and parse a text envelope, or route this role to an adapter that implements native tools.",
    );
    this.name = "ModelToolsUnsupportedError";
    this.modelId = modelId;
    this.toolCount = toolCount;
  }
}

export class CredentialMissingError extends Error {
  readonly handle: string;
  constructor(handle: string) {
    super(
      `no credential is stored for handle "${handle}"; configure the model before using it`,
    );
    this.name = "CredentialMissingError";
    this.handle = handle;
  }
}

/**
 * The router was asked for a capability (native tool calling) that none of the
 * routed adapters implements. Thrown before any network call on purpose: picking
 * a text-envelope adapter here would silently drop the tool descriptors the caller
 * negotiated. This is a permanent configuration mismatch, never retried.
 */
export class ModelCapabilityUnsatisfiedError extends Error {
  readonly role: string;
  readonly capability: string;
  constructor(role: string, capability: string, detail: string) {
    super(`no model on the "${role}" route can satisfy "${capability}": ${detail}`);
    this.name = "ModelCapabilityUnsatisfiedError";
    this.role = role;
    this.capability = capability;
  }
}
