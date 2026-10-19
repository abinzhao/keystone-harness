/**
 * OpenAI-compatible chat completions adapter (BYOK).
 *
 * Implemented against the HTTP surface with the platform `fetch` rather than an
 * SDK: the kernel has no runtime dependencies, and a provider SDK would put its
 * own version, telemetry and retry semantics between the user's key and the
 * request (ADR-0004).
 *
 * The API key is fetched from the credential store at call time. Nothing in this
 * file logs, returns or embeds it — including error paths, where a leaked key in
 * a stack trace is the classic way a "local-first" tool stops being local.
 */

import type { ModelDescriptor } from "@keystone/schemas";

import {
  CredentialMissingError,
  ModelProtocolError,
  ModelUnavailableError,
  type CredentialResolver,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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
          throw mapHttpFailure(descriptor, response, secret);
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
        if (isAbort(error)) {
          throw new ModelUnavailableError(
            descriptor.id,
            `the model call did not answer within ${timeoutMs}ms`,
          );
        }
        throw new ModelUnavailableError(
          descriptor.id,
          `the model call failed: ${redact(describeError(error), secret)}`,
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortExternal);
      }
    },
  };
}

function mapHttpFailure(
  descriptor: ModelDescriptor,
  response: Response,
  secret: string,
): ModelUnavailableError | ModelProtocolError {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new ModelUnavailableError(
      descriptor.id,
      `the provider rejected the stored credential for "${descriptor.credentialHandle ?? "?"}" (HTTP ${status}); ` +
        "the key itself is never included in errors — check the credential store",
      false,
    );
  }
  if (status === 404) {
    return new ModelUnavailableError(
      descriptor.id,
      `the provider does not expose "${descriptor.modelName}" at ${descriptor.endpointHost} (HTTP 404)`,
      false,
    );
  }
  if (status === 429 || status >= 500) {
    return new ModelUnavailableError(
      descriptor.id,
      `the provider is temporarily unavailable (HTTP ${status}); switching models or waiting is safe`,
      true,
    );
  }
  return new ModelUnavailableError(
    descriptor.id,
    `the provider rejected the request (HTTP ${status})`,
    false,
  );
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last line of defence: nothing leaves this module containing the key. */
function redact(message: string, secret: string): string {
  if (secret.length < 8) return message;
  return message.split(secret).join("<redacted>");
}
