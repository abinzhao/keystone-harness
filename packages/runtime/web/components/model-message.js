import { button, jsonDetails, node, note, tr } from "./dom.js";
import { copyText } from "./clipboard.js";

function inline(text, openFile) {
  const result = [];
  let offset = 0;
  for (const match of text.matchAll(/(?:^|\s)@("[^"]+"|[^\s,;]+)/g)) {
    const start = match.index + (match[0].startsWith("@") ? 0 : 1);
    const value = match[1].replace(/^"|"$/g, "");
    const parts = /^(.*?)(?::([1-9]\d{0,6})(?:-[1-9]\d{0,6})?)?$/.exec(value);
    const path = parts?.[1];
    if (!openFile || !path || path.startsWith("/") || path.includes("\\") || path.includes(":")
      || path.split("/").some((part) => part === ".." || part === "." || !part) || /[<>"\u0000-\u001f]/.test(path)) continue;
    result.push(text.slice(offset, start), button(value, () => openFile(path, Number(parts[2] ?? 1)), "file-reference"));
    offset = start + match[0].length - (start - match.index);
  }
  result.push(text.slice(offset));
  return result;
}

export function modelMessage(message, { openFile } = {}) {
  const article = node("article", { class: "model-message" }, [
    node("div", { class: "message-source" }, [
      node("strong", { text: tr("Model output") }),
      node("span", { text: message.modelId ?? tr("Unknown") }),
      node("time", { text: message.at ?? "" }),
      node("span", { class: "chip warn", text: tr("Untrusted; not independent evidence") }),
    ]),
  ]);
  const text = typeof message.text === "string" ? message.text : "";
  const lines = text.slice(0, 512 * 1024).split("\n");
  let paragraph = []; let code = null; let language = ""; let list = null;
  const flush = () => {
    if (paragraph.length) article.append(node("p", {}, inline(paragraph.join("\n"), openFile)));
    paragraph = []; list = null;
  };
  const flushCode = () => {
    const source = code.join("\n");
    article.append(node("div", { class: "message-code" }, [
      node("div", { class: "row" }, [node("small", { text: language }), button("Copy code", () => copyText(source))]),
      node("pre", {}, [node("code", { text: source })]),
    ]));
    code = null;
  };
  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      if (code) flushCode(); else { flush(); code = []; language = fence[1]; }
    } else if (code) code.push(line);
    else if (!line.trim()) flush();
    else {
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      const item = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
      if (heading) { flush(); article.append(node(`h${Math.min(heading[1].length + 2, 6)}`, {}, inline(heading[2], openFile))); }
      else if (item) {
        if (!list) { flush(); list = node("ul"); article.append(list); }
        list.append(node("li", {}, inline(item[1], openFile)));
      } else { list = null; paragraph.push(line); }
    }
  }
  if (code) flushCode(); flush();
  if (text.length > 512 * 1024) article.append(note("Message preview truncated. Inspect the source artifact for full content.", "warn"));
  article.append(button("Copy response", () => copyText(text)), jsonDetails("Message source and hash", {
    modelId: message.modelId, at: message.at, trustLevel: "untrusted",
    artifactId: message.artifactId, contentHash: message.contentHash,
  }));
  return article;
}
