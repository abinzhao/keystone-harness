import { node, tr } from "./dom.js";

export async function copyText(value) {
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error(tr("Clipboard unavailable. Select the text or export it locally."));
  await navigator.clipboard.writeText(value);
}

export function exportText(name, value) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  node("a", { href: url, download: name.split(/[\\/]/).at(-1) || "draft.txt" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
