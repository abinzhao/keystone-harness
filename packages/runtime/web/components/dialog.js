import { el, button, node, tr } from "./dom.js";

export function createDialogs() {
  const dialog = el("modal");
  let resolve = null;
  let lastFocus = null;
  let generation = 0;
  const api = {
    get generation() { return generation; },
    close(result = null) {
      if (!dialog.open) return;
      const pending = resolve; resolve = null;
      generation += 1;
      dialog.close();
      pending?.(result);
      if (lastFocus?.isConnected) lastFocus.focus();
      lastFocus = null;
    },
    open(title, content, actions = []) {
      if (dialog.open) api.close(null);
      generation += 1;
      lastFocus = document.activeElement;
      el("modal-title").textContent = tr(title);
      el("modal-body").replaceChildren(content);
      el("modal-foot").replaceChildren(...actions);
      dialog.showModal();
      (content.querySelector?.("input,textarea,select") ?? actions[0] ?? el("modal-close")).focus();
      return generation;
    },
    confirm(title, content, label = "Confirm", danger = false) {
      return new Promise((done) => {
        const cancel = button("Cancel", () => api.close(false));
        const accept = button(label, () => api.close(true), danger ? "danger" : "primary");
        api.open(title, content, [cancel, accept]);
        resolve = done;
        cancel.focus();
      });
    },
    prompt(title, label, initial = "") {
      return new Promise((done) => {
        const id = "dialog-input";
        const input = node("input", { id });
        input.value = initial;
        api.open(title, node("div", { class: "field" }, [node("label", { for: id, text: tr(label) }), input]),
          [button("Cancel", () => api.close(null)), button("Save", () => { if (input.value.trim()) api.close(input.value.trim()); }, "primary")]);
        resolve = done; input.focus();
      });
    },
  };
  el("modal-close").onclick = () => api.close(null);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); api.close(null); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && event.offsetY < 0) api.close(null); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    const pending = resolve; resolve = null; pending?.(null);
  });
  return api;
}
