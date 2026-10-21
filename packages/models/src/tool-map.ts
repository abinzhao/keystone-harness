/**
 * Neutral tool-descriptor -> provider function schema mapping (ADR-0010 §2).
 *
 * Providers disagree on how a tool's parameter schema is shaped (OpenAI function
 * `parameters`, Anthropic `input_schema`, Gemini `functionDeclarations[].parameters`),
 * but every one wants the same JSON-schema body. We resolve the descriptor's
 * registered input schema once and hand the provider its own envelope around it.
 *
 * The adapter maps; it never executes. If a descriptor references an input schema
 * that is not registered, we degrade to an empty-object schema rather than throw —
 * a tool the runtime never wires up is the common test/offline path, and failing
 * there would block an otherwise valid call.
 */

import { getSchema, type ToolDescriptor } from "@keystone/schemas";

export function toolParametersSchema(tool: ToolDescriptor): Record<string, unknown> {
  const schema = getSchema(tool.inputSchemaId);
  if (schema === undefined) return { type: "object", properties: {} };
  const json = schema.toJsonSchema() as Record<string, unknown>;
  // The derived JSON Schema carries $schema/$id bookkeeping providers reject on
  // some endpoints; strip the envelope, keep the structural definition.
  const { $schema: _s, $id: _i, ...rest } = json;
  void _s;
  void _i;
  return rest;
}
