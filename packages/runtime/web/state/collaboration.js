export function parsePublicJson(input) {
  let value;
  try { value = JSON.parse(input); }
  catch { throw new Error("Enter a valid JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a valid JSON object.");
  const inspect = (item, depth = 0) => {
    if (depth > 64) throw new Error("The JSON exceeds the nesting limit.");
    if (typeof item === "string" && /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(item)) throw new Error("Remove secret fields or private key material before verification.");
    if (typeof item === "string" && /(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret)\s*[:=]\s*\S+|\bBearer\s+\S+|:\/\/[^/\s:@]+:[^/\s@]+@)/i.test(item)) throw new Error("Remove secret-shaped text before sending public content.");
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (/^(password|passwd|token|accessToken|refreshToken|apiKey|secret|privateKey|credentials|authorization|cookie)$/i.test(key)) throw new Error("Remove secret fields or private key material before verification.");
        inspect(child, depth + 1);
      }
    }
  };
  inspect(value);
  return value;
}
