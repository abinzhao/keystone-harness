export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json", "application/x-ndjson"];
const TEXT_SUFFIX = /\.(?:txt|md|markdown|log|csv|json|jsonl|ts|js|css|html|yaml|yml|xml)$/i;

export function attachmentMime(file) {
  if (IMAGE_TYPES.includes(file.type) || TEXT_TYPES.includes(file.type) || file.type?.startsWith("text/")) return file.type;
  if (!file.type && TEXT_SUFFIX.test(file.name)) return "text/plain";
  return null;
}

export function validateAttachment(file, count) {
  if (count >= 10) return "Too many attachments (maximum 10).";
  const mime = attachmentMime(file);
  if (!mime) return "Unsupported attachment type.";
  if (file.size > (IMAGE_TYPES.includes(mime) ? 20 : 10) * 1024 * 1024) {
    return IMAGE_TYPES.includes(mime) ? "Image exceeds 20 MiB." : "Text exceeds 10 MiB.";
  }
  return null;
}

export function parseFileReferences(text) {
  const results = [];
  const pattern = /(?:^|\s)@("[^"]+"|[^\s,;]+)/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/^"|"$/g, "");
    if (value) results.push({ kind: value.endsWith("/") ? "directory" : "file", value });
  }
  return results;
}

export function referencesFromWritePaths(paths) {
  return paths.map((raw) => raw.replace(/\/\*\*?$/, "").replace(/\/$/, "")).filter(Boolean)
    .map((value) => ({ kind: /\.[A-Za-z0-9]+$/.test(value) ? "file" : "directory", value }));
}

export function routedModels(config, role = "builder", runtimeEgress = [], modelId = "") {
  const enabled = (config?.models ?? []).filter((entry) => entry.enabled);
  if (modelId) return [...enabled, ...runtimeEgress.filter((entry) => entry.role === role).map((entry) => ({
    id: entry.modelId, modelName: entry.modelId, kind: entry.local ? "local" : "cloud",
    endpointHost: entry.endpointHost, multimodal: entry.multimodal, enabled: true,
  }))].filter((entry) => entry.id === modelId).slice(0, 1);
  const ids = config?.routes?.[role] ?? [];
  const routed = ids.map((id) => enabled.find((entry) => entry.id === id)).filter(Boolean);
  if (routed.length) return routed;
  if (enabled.length || config?.models?.length) return enabled;
  return runtimeEgress.filter((entry) => entry.role === role).map((entry) => ({
    id: entry.modelId, modelName: entry.modelId, kind: entry.local ? "local" : "cloud",
    endpointHost: entry.endpointHost, multimodal: entry.multimodal, enabled: true,
  }));
}

export function imageRouteWarning(config, attachments, runtimeEgress = [], modelId = "") {
  if (!attachments.some((entry) => entry.kind === "image")) return null;
  const models = routedModels(config, "builder", runtimeEgress, modelId);
  if (!models.length || models.some((model) => model.multimodal !== true)) {
    return "Image input is not declared for every routed model. Remove images or explicitly configure a compatible route; no automatic cloud fallback.";
  }
  return null;
}

export async function confirmAttachmentEgress(config, attachments, confirm, isCurrent, runtimeEgress = [], modelId = "") {
  if (!attachments.length) return {};
  const models = routedModels(config, "builder", runtimeEgress, modelId);
  if (!models.length) return null;
  const destinations = models.filter((model) => model.kind === "cloud")
    .map(({ id, modelName, endpointHost, protocol }) => ({ id, modelName, endpointHost, protocol }));
  if (!destinations.length) return {};
  const files = attachments.map(({ attachmentId, name, mimeType, size, contentHash, kind }) => ({ attachmentId, name, mimeType, size, contentHash, kind }));
  if (!(await confirm({ destinations, files })) || !isCurrent()) return null;
  return { allowAttachmentEgress: true };
}

export function fileReference(path, line = null, end = null) {
  const value = `${path}${line ? `:${line}${end && end !== line ? `-${end}` : ""}` : ""}`;
  return `@${/\s/.test(value) ? `"${value}"` : value}`;
}
