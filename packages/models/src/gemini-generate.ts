/**
 * Gemini GenerateContent adapter (native tools + structured output).
 *
 * Speaks `POST {baseUrl}/models/{model}:generateContent` with the
 * `x-goog-api-key` header. Roles are remapped (`assistant` -> `model`), system
 * content becomes `systemInstruction`, and function-call parts map to the neutral
 * `ModelToolCall` shape. JSON output is constrained with
 * `generationConfig.responseMimeType` (ADR-0010 §2).
 */

import type { ModelDescriptor } from "@keystone/schemas";

import type {
  CredentialResolver,
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./types.ts";
import { asCount, type FetchLike } from "./http.ts";
import { callProvider, resolveCallSecret } from "./adapter-base.ts";
import { toolParametersSchema } from "./tool-map.ts";

export interface GeminiGenerateOptions {
  readonly descriptor: ModelDescriptor;
  readonly credentials: CredentialResolver;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createGeminiGenerateAdapter(options: GeminiGenerateOptions): ModelAdapter {
  const { descriptor, credentials } = options;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(descriptor.modelName)}:generateContent`;

  return {
    descriptor,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const secret = await resolveCallSecret(descriptor, credentials);
      const { system, contents } = splitGemini(request.messages);
      const json = await callProvider({
        descriptor,
        request,
        url: endpoint,
        headers: { "x-goog-api-key": secret },
        body: {
          ...(system === "" ? {} : { systemInstruction: { parts: [{ text: system }] } }),
          contents,
          ...(request.tools.length === 0
            ? {}
            : {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.id,
                      description: tool.description,
                      parameters: toolParametersSchema(tool),
                    })),
                  },
                ],
              }),
          generationConfig: {
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
            ...(request.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        },
        secret,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      return mapGenerate(descriptor, json);
    },
  };
}

function splitGemini(messages: readonly ModelMessage[]): {
  readonly system: string;
  readonly contents: readonly { readonly role: string; readonly parts: readonly { text: string }[] }[];
} {
  const system: string[] = [];
  const contents: { readonly role: string; readonly parts: readonly { text: string }[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }
  return { system: system.join("\n\n"), contents };
}

interface Part {
  readonly text?: unknown;
  readonly functionCall?: unknown;
}

function mapGenerate(
  descriptor: ModelDescriptor,
  json: Record<string, unknown>,
): ModelResponse {
  const candidate = Array.isArray(json["candidates"]) ? json["candidates"][0] : undefined;
  const parts =
    typeof candidate === "object" && candidate !== null && Array.isArray(
      (candidate as { content?: { parts?: unknown } }).content?.parts,
    )
      ? ((candidate as { content: { parts: readonly Part[] } }).content.parts)
      : [];

  const text = parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");

  const toolCalls: ModelToolCall[] = [];
  for (const part of parts) {
    if (typeof part.functionCall !== "object" || part.functionCall === null) continue;
    const call = part.functionCall as { name?: unknown; args?: unknown };
    toolCalls.push({
      id: `call_${toolCalls.length}`,
      name: typeof call.name === "string" ? call.name : "",
      args:
        typeof call.args === "object" && call.args !== null
          ? (call.args as Record<string, unknown>)
          : {},
    });
  }

  const usage = (json["usageMetadata"] ?? {}) as {
    readonly promptTokenCount?: unknown;
    readonly candidatesTokenCount?: unknown;
  };
  const finishReason =
    typeof candidate === "object" && candidate !== null &&
    typeof (candidate as { finishReason?: unknown }).finishReason === "string"
      ? ((candidate as { finishReason: string }).finishReason)
      : "stop";

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: asCount(usage.promptTokenCount),
      outputTokens: asCount(usage.candidatesTokenCount),
    },
    modelName: descriptor.modelName,
    finishReason,
  };
}
