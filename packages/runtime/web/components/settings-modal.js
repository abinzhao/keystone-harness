import { note, notify, tr } from "./dom.js";

/** Settings keep their own draft while the selected task continues polling. */
export function createSettingsModal({ dialog, host, closeButton, dialogs, createView, onDiscard }) {
  let view = null;
  let focus = null;
  let generation = 0;
  let closing = false;
  let disposed = false;
  function release() {
    generation += 1;
    view?.dispose(); view = null;
    host.replaceChildren();
    if (focus?.isConnected) focus.focus();
    focus = null;
  }
  const api = {
    get openState() { return dialog.open; },
    open() {
      if (disposed || dialog.open) return;
      generation += 1; focus = document.activeElement;
      view = createView(host);
      dialog.showModal(); closeButton.focus();
    },
    async close() {
      if (!dialog.open) return true;
      if (closing || view?.saving) {
        if (view?.saving) notify(tr("Wait for the settings save to finish before closing."), true);
        return false;
      }
      const selected = generation;
      closing = true;
      try {
        const dirty = view?.dirty;
        if (dirty && !(await dialogs.confirm("Discard settings draft", note("Leaving settings discards unsaved configuration changes."), "Discard draft", true))) return false;
        if (disposed || selected !== generation || view?.saving) return false;
        if (dirty) onDiscard?.();
        dialog.close(); release();
        return true;
      } finally { closing = false; }
    },
    dispose() { disposed = true; dialog.close(); release(); },
  };
  closeButton.onclick = () => { void api.close(); };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void api.close(); });
  dialog.addEventListener("close", () => { if (!dialog.open && view) release(); });
  return api;
}
