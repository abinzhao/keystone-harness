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

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
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

export interface ModelResponse {
  readonly text: string;
  readonly usage: ModelUsage;
  readonly modelName: string;
  readonly finishReason: string;
}

export type ModelRole = "builder" | "summarizer" | "planner";

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
