import {
  ModelContentInvalidError,
  ModelContentUnsupportedError,
  type ModelContentPart,
  type ModelDescriptor,
  type ModelMessage,
  type ModelRequest,
} from "./types.ts";

export function contentParts(content: ModelMessage["content"]): readonly ModelContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new ModelContentInvalidError();
  for (const part of content) {
    if (typeof part !== "object" || part === null) throw new ModelContentInvalidError();
    if (part.type === "text" && typeof part.text === "string") continue;
    if (part.type !== "image" ||
        !["image/png", "image/jpeg", "image/webp"].includes(part.mimeType) ||
        typeof part.data !== "string" || part.data === "" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data) ||
        Buffer.from(part.data, "base64").toString("base64") !== part.data ||
        (part.artifactId !== undefined && typeof part.artifactId !== "string") ||
        (part.sourceId !== undefined && typeof part.sourceId !== "string")) {
      throw new ModelContentInvalidError();
    }
  }
  return content;
}

export function requestHasImages(request: ModelRequest): boolean {
  return request.messages.some((message) =>
    contentParts(message.content).some((part) => part.type === "image"));
}

export function assertModelContent(descriptor: ModelDescriptor, request: ModelRequest): void {
  for (const message of request.messages) {
    const images = contentParts(message.content).some((part) => part.type === "image");
    if (images && (!descriptor.capabilities.multimodal || message.role !== "user")) {
      throw new ModelContentUnsupportedError(descriptor.id,
        message.role !== "user" ? "images require a user message" : "multimodal is not enabled");
    }
  }
}

export function contentText(content: ModelMessage["content"]): string {
  return contentParts(content).map((part) => {
    if (part.type !== "text") throw new ModelContentUnsupportedError("system", "system messages are text-only");
    return part.text;
  }).join("");
}

export function mapContent(
  content: ModelMessage["content"],
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-generate",
): readonly Record<string, unknown>[] {
  return contentParts(content).map((part) => {
    if (part.type === "text") {
      return protocol === "gemini-generate" ? { text: part.text }
        : { type: protocol === "openai-responses" ? "input_text" : "text", text: part.text };
    }
    const dataUrl = `data:${part.mimeType};base64,${part.data}`;
    switch (protocol) {
      case "openai-chat": return { type: "image_url", image_url: { url: dataUrl } };
      case "openai-responses": return { type: "input_image", image_url: dataUrl };
      case "anthropic-messages": return {
        type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data },
      };
      case "gemini-generate": return { inlineData: { mimeType: part.mimeType, data: part.data } };
    }
  });
}
