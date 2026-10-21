/**
 * OpenAI-compatible chat completions adapter (BYOK).
 *
 * Implemented against the HTTP surface with the platform `fetch` rather than an
 * SDK: the kernel has no runtime dependencies, and a provider SDK would put its
 * own version, telemetry and retry semantics between the user's key and the
 * request (ADR-0004).
 *
 * This is the **text-envelope** adapter: it speaks no native tool calling. When a
 * request carries tool descriptors it refuses *before* any network call, because
 * silently dropping them would leave the caller believing structured calls are
 * negotiated (ADR-0010 §3). It does enforce JSON output (`response_format`).
 *
 * The API key is fetched from the credential store at call time. Nothing in this
 * file logs, returns or embeds it — including error paths, where a leaked key in
 * a stack trace is the classic way a "local-first" tool stops being local.
 */

import type { ModelDescriptor } from "@keystone/schemas";

import {
  CredentialMissingError,
  ModelProtocolError,
  ModelToolsUnsupportedError,
  ModelUnavailableError,
  type CredentialResolver,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from "./types.ts";
import {
  asCount,
  describeError,
  httpFailure,
  isAbortError,
  redactSecret,
  type FetchLike,
} from "./http.ts";

export type { FetchLike };

export interface OpenAiCompatibleOptions {
  readonly descriptor: ModelDescriptor;
  readonly credentials: CredentialResolver;
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

interface ChatCompletionBody {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
  readonly error?: { readonly message?: unknown; readonly type?: unknown };
}

export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ModelAdapter {
  const { descriptor, credentials } = options;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    descriptor,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      // No native tool calling: this adapter sends a text envelope and nothing
      // else. A non-empty `tools` array means the caller expects structured tool
      // negotiation, which we must refuse *before* spending a credential lookup
      // or a network round trip.
      if (request.tools.length > 0) {
        throw new ModelToolsUnsupportedError(descriptor.id, request.tools.length);
      }

      const handle = descriptor.credentialHandle;
      if (handle === undefined) {
        throw new CredentialMissingError(`${descriptor.id}:no-handle`);
      }
      const secret = await credentials.resolve(handle);
      if (secret === undefined) {
        throw new CredentialMissingError(handle);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      const abortExternal = (): void => {
        controller.abort();
      };
      request.signal?.addEventListener("abort", abortExternal, { once: true });

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({
            model: descriptor.modelName,
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            stream: false,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
            ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw httpFailure(descriptor.id, response.status, secret, {
            credentialHandle: handle,
            endpointHost: descriptor.endpointHost,
          });
        }

        const body = (await response.json().catch(() => {
          throw new ModelProtocolError(descriptor.id, "the provider returned a body that is not JSON");
        })) as ChatCompletionBody;

        const choice = body.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string") {
          throw new ModelProtocolError(
            descriptor.id,
            "the provider response contains no message content",
          );
        }

        return {
          text: content,
          toolCalls: [],
          usage: {
            inputTokens: asCount(body.usage?.prompt_tokens),
            outputTokens: asCount(body.usage?.completion_tokens),
          },
          modelName: descriptor.modelName,
          finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown",
        };
      } catch (error) {
        if (error instanceof ModelProtocolError || error instanceof CredentialMissingError) throw error;
        if (error instanceof ModelUnavailableError) throw error;
        if (isAbortError(error)) {
          throw new ModelUnavailableError(
            descriptor.id,
            `the model call did not answer within ${timeoutMs}ms`,
          );
        }
        throw new ModelUnavailableError(
          descriptor.id,
          `the model call failed: ${redactSecret(describeError(error), secret)}`,
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortExternal);
      }
    },
  };
}
