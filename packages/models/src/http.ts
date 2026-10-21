/**
 * Shared HTTP plumbing for the provider adapters (ADR-0010 §4).
 *
 * One place owns: timeout/abort wiring, HTTP-status -> retryability
 * classification, and secret redaction. Every adapter posts JSON itself, but
 * turns a failure into an error through these helpers so the retry contract and
 * "the key never leaves the module" promise do not drift between providers.
 */

import { ModelUnavailableError } from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpCallOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface JsonCall extends HttpCallOptions {
  readonly modelId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * POST JSON and return the parsed body. A non-JSON body yields an empty object
 * (the caller then validates the shape it expects and raises a protocol error),
 * and an abort/timeout becomes a retriable `ModelUnavailableError`.
 */
export async function postJsonBody(
  call: JsonCall,
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, call.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  call.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (call.signal?.aborted) controller.abort();
  try {
    const response = await (call.fetchImpl ?? fetch)(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...call.headers },
      body: JSON.stringify(call.body),
      signal: controller.signal,
      redirect: "error",
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, json };
  } catch (error) {
    if (isAbortError(error)) {
      throw new ModelUnavailableError(
        call.modelId,
        `the model call did not answer within ${call.timeoutMs}ms`,
        true,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Turn a non-2xx provider response into the right error class.
 *
 * 401/403 and 404 are permanent (bad credential / wrong model or host);
 * 408/429/5xx are transient and safe to retry. The secret is redacted from the
 * message and never named — only the handle is.
 */
export function httpFailure(
  modelId: string,
  status: number,
  secret: string,
  context: { readonly credentialHandle?: string; readonly endpointHost: string },
): ModelUnavailableError {
  const message = failureMessage(status, context);
  return new ModelUnavailableError(modelId, redactSecret(message, secret), statusRetriable(status));
}

function failureMessage(
  status: number,
  context: { readonly credentialHandle?: string; readonly endpointHost: string },
): string {
  if (status === 401 || status === 403) {
    return (
      `the provider rejected the stored credential for "${context.credentialHandle ?? "?"}" ` +
      `(HTTP ${status}); the key itself is never included — check the credential store`
    );
  }
  if (status === 404) {
    return `the provider does not expose this model at ${context.endpointHost} (HTTP 404)`;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return `the provider is temporarily unavailable (HTTP ${status}); switching models or waiting is safe`;
  }
  return `the provider rejected the request (HTTP ${status})`;
}

function statusRetriable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Last line of defence: nothing that leaves an adapter contains the secret. */
export function redactSecret(message: string, secret: string): string {
  if (secret.length === 0) return message;
  return message.split(secret).join("<redacted>");
}

export function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
