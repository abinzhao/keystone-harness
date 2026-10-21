/**
 * The shared spine of every HTTP provider adapter (ADR-0010 §4).
 *
 * Credential resolution, the POST, and the error/redaction path are identical
 * across providers; only the request body and the response mapping differ. This
 * base owns those so the retry contract and "the secret never leaves" promise live
 * in exactly one place.
 */

import {
  CredentialMissingError,
  ModelUnavailableError,
  type CredentialResolver,
  type ModelDescriptor,
  type ModelRequest,
} from "./types.ts";
import {
  describeError,
  httpFailure,
  postJsonBody,
  redactSecret,
  type FetchLike,
} from "./http.ts";

/** Resolve the secret once. Throws before any network call when it is absent. */
export async function resolveCallSecret(
  descriptor: ModelDescriptor,
  credentials: CredentialResolver,
): Promise<string> {
  const handle = descriptor.credentialHandle;
  if (handle === undefined) {
    throw new CredentialMissingError(`${descriptor.id}:no-handle`);
  }
  const secret = await credentials.resolve(handle);
  if (secret === undefined) {
    throw new CredentialMissingError(handle);
  }
  return secret;
}

export interface ProviderCall {
  readonly descriptor: ModelDescriptor;
  readonly request: ModelRequest;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly secret: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** POST with the resolved secret and normalise failures. Returns parsed JSON. */
export async function callProvider(call: ProviderCall): Promise<Record<string, unknown>> {
  try {
    const { status, json } = await postJsonBody({
      modelId: call.descriptor.id,
      url: call.url,
      headers: call.headers,
      body: call.body,
      fetchImpl: call.fetchImpl,
      timeoutMs: call.timeoutMs ?? 120_000,
      signal: call.request.signal,
    });
    if (status < 200 || status >= 300) {
      throw httpFailure(call.descriptor.id, status, call.secret, {
        credentialHandle: call.descriptor.credentialHandle,
        endpointHost: call.descriptor.endpointHost,
      });
    }
    return json;
  } catch (error) {
    if (error instanceof CredentialMissingError || error instanceof ModelUnavailableError) {
      throw error;
    }
    throw new ModelUnavailableError(
      call.descriptor.id,
      `the model call failed: ${redactSecret(describeError(error), call.secret)}`,
    );
  }
}
