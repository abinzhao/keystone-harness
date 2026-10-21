/**
 * Scripted (deterministic) model adapter.
 *
 * This is not an intelligence and is not presented as one. It exists for three
 * legitimate purposes: driving the kernel's tests without network access, running
 * the Minimal Runtime for evaluation and fault isolation (PRD EX-05), and
 * reproducing a recorded run during replay.
 *
 * It reports zero token usage rather than an estimate. Inventing token counts
 * would corrupt the one metric the product claims to measure honestly
 * (PRD CX-03, NFR-PERF-06).
 */

import type { ModelDescriptor } from "@keystone/schemas";

import type { ModelAdapter, ModelRequest, ModelResponse } from "./types.ts";

export interface ScriptedAdapterOptions {
  readonly descriptor: ModelDescriptor;
  /**
   * Produces the response text for a call. `callIndex` is zero-based, which lets
   * a test describe a sequence of turns.
   */
  readonly respond: (request: ModelRequest, callIndex: number) => string;
}

export interface ScriptedAdapter extends ModelAdapter {
  /** Number of completed calls, for assertions in tests. */
  readonly callCount: () => number;
  /** Requests seen so far, so a test can assert what was actually sent. */
  readonly requests: () => readonly ModelRequest[];
}

export function createScriptedAdapter(options: ScriptedAdapterOptions): ScriptedAdapter {
  const seen: ModelRequest[] = [];

  return {
    descriptor: options.descriptor,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const callIndex = seen.length;
      seen.push(request);
      const text = options.respond(request, callIndex);
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        modelName: options.descriptor.modelName,
        finishReason: "stop",
      };
    },

    callCount(): number {
      return seen.length;
    },

    requests(): readonly ModelRequest[] {
      return seen;
    },
  };
}

/** Convenience: reply with each response in turn, repeating the last one. */
export function createSequenceAdapter(options: {
  readonly descriptor: ModelDescriptor;
  readonly responses: readonly string[];
}): ScriptedAdapter {
  const responses = options.responses;
  if (responses.length === 0) {
    throw new Error("createSequenceAdapter needs at least one response");
  }
  return createScriptedAdapter({
    descriptor: options.descriptor,
    respond: (_request, callIndex) =>
      responses[Math.min(callIndex, responses.length - 1)] ?? "",
  });
}

export function scriptedModelDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: "scripted",
    kind: "local",
    provider: "keystone",
    modelName: "scripted-1",
    endpointHost: "local",
    protocol: "openai-chat",
    capabilities: {
      nativeTools: true,
      structuredOutput: true,
      streaming: false,
      multimodal: false,
      contextTokens: 32_000,
    },
    dataEgress: { classes: [], local: true },
    ...overrides,
  } as ModelDescriptor;
}
