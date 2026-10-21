/**
 * OpenAI Responses API adapter (native tools + structured output).
 *
 * Speaks `POST {baseUrl}/responses` rather than Chat Completions. Native function
 * calls come back as `output[].function_call` items and are mapped to the neutral
 * `ModelToolCall` shape; JSON output is constrained with `text.format`. The
 * adapter maps provider shapes only — it never executes a tool (ADR-0010 §2).
 */

import type { ModelDescriptor } from "@keystone/schemas";
import { assertModelContent, mapContent } from "./content.ts";

import { ModelProtocolError } from "./types.ts";
import type {
  CredentialResolver,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./types.ts";
import { asCount, type FetchLike } from "./http.ts";
import { callProvider, resolveCallSecret } from "./adapter-base.ts";
import { toolParametersSchema } from "./tool-map.ts";

export interface OpenAiResponsesOptions {
  readonly descriptor: ModelDescriptor;
  readonly credentials: CredentialResolver;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createOpenAiResponsesAdapter(options: OpenAiResponsesOptions): ModelAdapter {
  const { descriptor, credentials } = options;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/responses`;

  return {
    descriptor,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      assertModelContent(descriptor, request);
      const secret = await resolveCallSecret(descriptor, credentials);
      const json = await callProvider({
        descriptor,
        request,
        url: endpoint,
        headers: { authorization: `Bearer ${secret}` },
        body: {
          model: descriptor.modelName,
          input: request.messages.map((message) => ({
            role: message.role,
            content: typeof message.content === "string" ? message.content : mapContent(message.content, "openai-responses"),
          })),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
          ...(request.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  name: tool.id,
                  description: tool.description,
                  parameters: toolParametersSchema(tool),
                })),
              }),
        },
        secret,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      return mapResponses(descriptor, json);
    },
  };
}

interface OutputItem {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly call_id?: unknown;
}

function mapResponses(
  descriptor: ModelDescriptor,
  json: Record<string, unknown>,
): ModelResponse {
  const output = Array.isArray(json["output"]) ? (json["output"] as readonly OutputItem[]) : [];

  let text = typeof json["output_text"] === "string" ? (json["output_text"] as string) : "";
  if (text === "") {
    const parts: string[] = [];
    for (const item of output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === "output_text" && typeof block.text === "string") parts.push(block.text);
        }
      }
    }
    text = parts.join("");
  }

  const toolCalls: ModelToolCall[] = [];
  for (const item of output) {
    if (item.type !== "function_call") continue;
    let args: Record<string, unknown> = {};
    if (typeof item.arguments === "string" && item.arguments.trim() !== "") {
      try {
        args = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        throw new ModelProtocolError(
          descriptor.id,
          "the provider returned a function call whose arguments are not JSON",
        );
      }
    }
    toolCalls.push({
      id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
      name: typeof item.name === "string" ? item.name : "",
      args,
    });
  }

  const usage = (json["usage"] ?? {}) as {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
  };

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: asCount(usage.input_tokens),
      outputTokens: asCount(usage.output_tokens),
    },
    modelName: descriptor.modelName,
    finishReason: typeof json["status"] === "string" ? (json["status"] as string) : "stop",
  };
}
