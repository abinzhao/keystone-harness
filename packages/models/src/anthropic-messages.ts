/**
 * Anthropic Messages API adapter (native tools).
 *
 * Speaks `POST {baseUrl}/messages` with the `x-api-key` + `anthropic-version`
 * headers. System content is lifted out of the message list into the top-level
 * `system` field; tool-use blocks come back as `content[].tool_use` and are mapped
 * to the neutral `ModelToolCall` shape.
 *
 * Anthropic has no `response_format` knob, so `structuredOutput` is declared
 * false: JSON is requested in the prompt and always validated by the caller
 * (ADR-0010 §3). `jsonMode` on the request is accepted but not enforced here.
 */

import type { ModelDescriptor } from "@keystone/schemas";
import { assertModelContent, contentText, mapContent } from "./content.ts";

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

export interface AnthropicMessagesOptions {
  readonly descriptor: ModelDescriptor;
  readonly credentials: CredentialResolver;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createAnthropicMessagesAdapter(
  options: AnthropicMessagesOptions,
): ModelAdapter {
  const { descriptor, credentials } = options;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/messages`;

  return {
    descriptor,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      assertModelContent(descriptor, request);
      const secret = await resolveCallSecret(descriptor, credentials);
      const { system, messages } = splitSystem(request.messages);
      const json = await callProvider({
        descriptor,
        request,
        url: endpoint,
        headers: {
          "x-api-key": secret,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: descriptor.modelName,
          // Anthropic requires an output budget; the caller's maxTokens wins.
          max_tokens: request.maxTokens ?? 4096,
          ...(system === "" ? {} : { system }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          messages,
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  name: tool.id,
                  description: tool.description,
                  input_schema: toolParametersSchema(tool),
                })),
              }),
        },
        secret,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });

      return mapMessages(descriptor, json);
    },
  };
}

function splitSystem(messages: readonly ModelMessage[]): {
  readonly system: string;
  readonly messages: readonly { readonly role: string; readonly content: string | readonly Record<string, unknown>[] }[];
} {
  const system: string[] = [];
  const rest: { readonly role: string; readonly content: string | readonly Record<string, unknown>[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(contentText(message.content));
    else rest.push({ role: message.role, content: typeof message.content === "string"
      ? message.content : mapContent(message.content, "anthropic-messages") });
  }
  return { system: system.join("\n\n"), messages: rest };
}

interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

function mapMessages(
  descriptor: ModelDescriptor,
  json: Record<string, unknown>,
): ModelResponse {
  const content = Array.isArray(json["content"]) ? (json["content"] as readonly ContentBlock[]) : [];

  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");

  const toolCalls: ModelToolCall[] = content
    .filter((block) => block.type === "tool_use")
    .map((block, index) => ({
      id: typeof block.id === "string" ? block.id : `call_${index}`,
      name: typeof block.name === "string" ? block.name : "",
      args:
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {},
    }));

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
    finishReason: typeof json["stop_reason"] === "string" ? (json["stop_reason"] as string) : "stop",
  };
}
