import { node, button, tr, note, jsonDetails, notify, localGet, bytes } from "../components/dom.js";
import { post, taskPath } from "../client/api.js";
import { attachmentMime, validateAttachment, imageRouteWarning, parseFileReferences, referencesFromWritePaths, routedModels, confirmAttachmentEgress } from "../state/composer.js";

export function createComposer(host, { client, request, drafts, dialogs, getSettings, getEgress = () => [], afterStart, referencePicker }) {
  let selectedKey = "";
  let draftProjectId = null;
  let draftTaskId = null;
  let mode = "new";
  let draft = null;
  let attachments = [];
  let catalog = [];
  let version = 0;
  let busy = false;
  let uploading = 0;
  const uploads = new Set();
  const previews = new Map();
  const form = node("form", { class: "composer" });
  const input = node("textarea", { id: "composer-input", rows: "2", placeholder: tr("Describe the outcome or reference @file:line"), "aria-label": tr("Task input") });
  const operation = node("select", { "aria-label": tr("Input operation") }, [node("option", { value: "new", text: tr("New task") }), node("option", { value: "revise", text: tr("Revise outcome") })]);
  const attachInput = node("input", { type: "file", multiple: true, accept: ".png,.jpg,.jpeg,.webp,.txt,.md,.log,.csv,.json,.jsonl", class: "sr-only", tabindex: "-1", "aria-label": tr("Attach image or text files") });
  const chips = node("div", { "aria-label": tr("Attachments") });
  const feedback = node("div", { role: "status", "aria-live": "polite" });
  const writePaths = node("input", { id: "composer-write", placeholder: "src/**" });
  const commands = node("input", { id: "composer-commands", placeholder: "node, pnpm" });
  const reason = node("input", { id: "composer-reason" });
  const reasonField = node("div", { class: "field" }, [node("label", { for: reason.id, text: tr("Revision rationale") }), reason]);
  const access = node("select", { "aria-label": tr("Task access") }, [node("option", { value: "read", text: tr("Read only") }), node("option", { value: "write", text: tr("Scoped writes") })]);
  const options = node("details", { class: "composer-options" }, [
    node("summary", { text: tr("Scope and command boundaries") }),
    node("div", { class: "form-columns" }, [
      node("div", { class: "field" }, [node("label", { for: writePaths.id, text: tr("Write scope (comma separated)") }), writePaths]),
      node("div", { class: "field" }, [node("label", { for: commands.id, text: tr("Allowed commands (comma separated)") }), commands]),
      reasonField,
    ]),
  ]);
  const submit = node("button", { type: "submit", class: "primary", text: tr("Start task") });
  const removeAttachment = async (entry) => {
    const projectId = client.state.projectId;
    const key = selectedKey;
    await request(`/v1/attachments/${encodeURIComponent(entry.attachmentId)}`, { method: "DELETE" });
    if (key !== selectedKey || projectId !== client.state.projectId) return;
    attachments = attachments.filter((item) => item.attachmentId !== entry.attachmentId);
    if (previews.has(entry.attachmentId)) URL.revokeObjectURL(previews.get(entry.attachmentId));
    previews.delete(entry.attachmentId);
    persist(); paintAttachments();
  };
  const egress = () => {
    const models = routedModels(getSettings()?.config, "builder", getEgress());
    const content = node("div", { class: "stack" }, [
      note("Imported locally is not the same as sent. Submitting may send this input to the configured route."),
      jsonDetails("Selected attachments", attachments.map(({ name, mimeType, size, contentHash, kind }) => ({ name, mimeType, size, contentHash, kind }))),
      jsonDetails("Primary and fallback destinations", models.map(({ id, kind, endpointHost, protocol, multimodal }) => ({ id, kind, endpointHost, protocol, multimodal }))),
    ]);
    const warning = imageRouteWarning(getSettings()?.config, attachments, getEgress());
    if (warning) content.prepend(note(warning, "warn"));
    dialogs.open("Input and egress preview", content, [button("Close", () => dialogs.close())]);
  };
  form.append(feedback, input, chips, node("div", { class: "composer-controls" }, [
    operation, access, button("Attach", () => attachInput.click()), button("@ File", referencePicker),
    button("Imported files", async () => {
      const projectId = client.state.projectId; const capturedVersion = version;
      const response = await request(`/v1/attachments?${new URLSearchParams({ projectId })}`);
      if (capturedVersion !== version) return;
      catalog = response.attachments ?? [];
      const items = node("div", { class: "stack" });
      for (const entry of catalog) items.append(button(`${entry.name} · ${bytes(entry.size)}`, () => {
        if (attachments.length >= 10 || attachments.some((value) => value.attachmentId === entry.attachmentId)) return;
        attachments.push(entry); persist(); paintAttachments(); dialogs.close();
      }));
      if (!catalog.length) items.append(note("No imported attachments."));
      dialogs.open("Imported files", items);
    }), button("Egress preview", egress), submit,
  ]), options, attachInput);
  host.replaceChildren(form);
  const scopeTask = () => mode === "revise" ? client.state.taskId : null;
  function persist() {
    if (!draft) return;
    draft = drafts.set(draftProjectId, draftTaskId, {
      request: input.value, writePaths: writePaths.value, allowedCommands: commands.value, access: access.value,
      reason: reason.value, attachmentIds: attachments.map((entry) => entry.attachmentId),
    });
  }
  for (const control of [input, writePaths, commands, reason, access]) control.addEventListener("input", persist);
  input.addEventListener("keydown", (event) => {
    if (event.key === "@" && input.selectionStart === input.value.length) { event.preventDefault(); referencePicker(); }
  });
  function paintAttachments() {
    chips.replaceChildren();
    for (const entry of attachments) {
      const preview = button(`${entry.name} · ${bytes(entry.size)} · ${tr(entry.status)}`, () => {
        const url = previews.get(entry.attachmentId);
        const content = node("div", {}, [jsonDetails("Attachment source", entry)]);
        if (url && entry.kind === "image") {
          const image = node("img", { src: url, alt: entry.name });
          image.style.maxWidth = "100%"; content.prepend(image);
        }
        dialogs.open("Attachment preview", content);
      });
      const remove = button("Remove", () => removeAttachment(entry));
      remove.setAttribute("aria-label", tr("Remove {name}", { name: entry.name }));
      chips.append(node("div", { class: "attachment" }, [preview, remove]));
    }
    const warning = imageRouteWarning(getSettings()?.config, attachments, getEgress());
    if (warning) chips.append(note(warning, "warn"));
    submit.disabled = busy || uploading > 0 || !client.state.projectId || !!warning;
  }
  async function bindSelection() {
    const key = `${client.state.projectId}:${scopeTask()}:${mode}`;
    if (key === selectedKey) { paintAttachments(); return; }
    persist();
    version += 1; const selectedVersion = version;
    uploads.forEach((upload) => upload.abort()); uploads.clear(); uploading = 0;
    previews.forEach((url) => URL.revokeObjectURL(url)); previews.clear();
    selectedKey = key;
    draftProjectId = client.state.projectId; draftTaskId = scopeTask();
    draft = drafts.get(draftProjectId, draftTaskId);
    input.value = draft.request || (mode === "revise" ? client.state.detail?.contract?.goal ?? "" : "");
    writePaths.value = draft.writePaths; commands.value = draft.allowedCommands; reason.value = draft.reason; access.value = draft.access;
    attachments = []; feedback.replaceChildren();
    reasonField.hidden = mode !== "revise";
    submit.textContent = tr(mode === "revise" ? "Send revision" : "Start task");
    if (client.state.projectId && draft.attachmentIds.length) {
      try {
        const response = await request(`/v1/attachments?${new URLSearchParams({ projectId: client.state.projectId })}`);
        if (selectedVersion !== version) return;
        catalog = response.attachments ?? [];
        attachments = draft.attachmentIds.map((id) => catalog.find((entry) => entry.attachmentId === id)).filter(Boolean);
        if (attachments.length !== draft.attachmentIds.length) feedback.append(note("Some draft attachments are unavailable. Review input before submitting.", "warn"));
      } catch (error) { if (selectedVersion === version) feedback.append(note(error.message, "bad")); }
    }
    paintAttachments();
  }
  operation.onchange = () => { persist(); mode = operation.value; void bindSelection(); };
  const base64 = (file, signal) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    reader.onload = () => { signal.removeEventListener("abort", abort); resolve(String(reader.result).split(",")[1]); };
    reader.onerror = () => { signal.removeEventListener("abort", abort); reject(reader.error); };
    reader.readAsDataURL(file);
  });
  async function importFiles(files) {
    if (!client.state.projectId) { feedback.replaceChildren(note("Select a project before importing attachments.", "warn")); return; }
    const selectedVersion = version; const projectId = client.state.projectId;
    for (const file of files) {
      if (selectedVersion !== version) return;
      const rejection = validateAttachment(file, attachments.length + uploading);
      if (rejection) { feedback.append(note(tr("{name}: {reason}", { name: file.name, reason: tr(rejection) }), "bad")); continue; }
      const controller = new AbortController(); uploads.add(controller); uploading += 1; paintAttachments();
      feedback.replaceChildren(note(tr("Importing {name}", { name: file.name })));
      try {
        const data = await base64(file, controller.signal);
        const response = await request("/v1/attachments", { ...post({ projectId, name: file.name, mimeType: attachmentMime(file), data }), signal: controller.signal });
        if (controller.signal.aborted || selectedVersion !== version) return;
        attachments.push(response.attachment);
        if (response.attachment.kind === "image") previews.set(response.attachment.attachmentId, URL.createObjectURL(file));
        persist(); feedback.replaceChildren(note("Imported locally; not sent to a model.", "ok"));
      } catch (error) { if (!controller.signal.aborted && selectedVersion === version) feedback.replaceChildren(note(error.message, "bad")); }
      finally { uploads.delete(controller); if (selectedVersion === version) { uploading -= 1; paintAttachments(); } }
    }
  }
  attachInput.onchange = () => { void importFiles([...attachInput.files]); attachInput.value = ""; };
  form.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); form.classList.add("drop-target"); } });
  form.addEventListener("dragleave", () => form.classList.remove("drop-target"));
  form.addEventListener("drop", (event) => { event.preventDefault(); form.classList.remove("drop-target"); void importFiles([...event.dataTransfer.files]); });
  form.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) { event.preventDefault(); void importFiles(files); }
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || uploading || !input.value.trim() || !client.state.projectId) return;
    const warning = imageRouteWarning(getSettings()?.config, attachments, getEgress());
    if (warning) { feedback.replaceChildren(note(warning, "bad")); return; }
    const project = client.state.projects.find((entry) => entry.projectId === client.state.projectId);
    const key = selectedKey; const projectId = client.state.projectId; const taskId = client.state.taskId;
    const snapshot = input.value;
    const selectedVersion = version;
    const selectedSelection = client.selectionVersion;
    const configuration = getSettings();
    const runtimeEgress = getEgress();
    const attached = attachments.slice();
    const attachmentSignature = attached.map((entry) => entry.attachmentId).join(",");
    const isCurrent = () => selectedVersion === version && selectedSelection === client.selectionVersion && key === selectedKey && snapshot === input.value
      && configuration === getSettings() && JSON.stringify(runtimeEgress) === JSON.stringify(getEgress())
      && attachmentSignature === attachments.map((entry) => entry.attachmentId).join(",");
    persist(); busy = true; paintAttachments();
    try {
      if (mode === "revise") {
        if (client.state.run?.status !== "running") { feedback.replaceChildren(note("A revision applies only while the task is working", "warn")); return; }
        if (!reason.value.trim()) { reason.focus(); feedback.replaceChildren(note("A rationale is required.", "warn")); return; }
        if (attachments.length) { feedback.replaceChildren(note("The revision API cannot add attachments. Preserve this draft or start a new task.", "warn")); return; }
        const patch = { goal: snapshot, writePaths: access.value === "write" ? list(writePaths.value) : [], reason: reason.value.trim() };
        if (!(await dialogs.confirm("Review contract revision", node("div", {}, [note("A revision creates a new contract version. Earlier evidence must be re-evaluated."), jsonDetails("Current contract", client.state.detail.contract), jsonDetails("Proposed revision", patch)]), "Send revision"))) return;
        if (!isCurrent()) return;
        await request(`${taskPath(taskId)}/contract`, post(patch));
        notify(tr("Revision queued; the run will apply it at its next step."));
      } else {
        const paths = access.value === "write" ? list(writePaths.value) : [];
        if (access.value === "write" && !paths.length) { writePaths.focus(); options.open = true; feedback.replaceChildren(note("Scoped writes require explicit write paths.", "warn")); return; }
        const base = {
          workspacePath: project.rootPath, request: snapshot, writePaths: paths, allowedCommands: list(commands.value),
          references: [...referencesFromWritePaths(paths), ...parseFileReferences(snapshot)],
          attachmentIds: attachments.map((entry) => entry.attachmentId), confirmAllWrites: localGet("keystone.confirmAllWrites") === "1",
        };
        let startMode = "confirmed";
        if (paths.length) {
          const preview = await request("/v1/contract/preview", post(base));
          if (!isCurrent()) return;
          if (preview.risk?.decision === "refuse") {
            dialogs.open("This task will not start", node("div", {}, [note(preview.risk.recovery ?? "This task is refused for this working copy.", "bad"), jsonDetails("Contract and refusal", preview)])); return;
          }
          if (preview.risk?.decision === "auto_start") {
            startMode = "auto";
            feedback.replaceChildren(note("Low-risk startup approved by the server. You can pause or stop at any time."));
          } else if (!(await dialogs.confirm("Confirm the scope of this task", node("div", {}, [
            note("This task can write to your repository. Review the exact contract and permission envelope."),
            jsonDetails("Goal, conditions, scope and budget", preview.contract), jsonDetails("Risk and questions", { risk: preview.risk, questions: preview.questions, writePaths: preview.writePaths, allowedCommands: preview.allowedCommands }),
          ]), "Start task (I accept this scope)"))) return;
        }
        if (!isCurrent()) return;
        const grant = await confirmAttachmentEgress(configuration?.config, attached, (plan) => dialogs.confirm(
          "Confirm attachment egress",
          node("div", { class: "stack" }, [
            note("Send the following files to these configured cloud model hosts for this task only? Cancel keeps the local draft."),
            node("h3", { text: tr("Cloud destinations") }),
            ...plan.destinations.map((destination) => node("p", { text: `${destination.modelName || destination.id} · ${destination.endpointHost}` })),
            node("h3", { text: tr("Selected attachments") }),
            ...plan.files.map((file) => node("p", { text: `${file.name} · ${bytes(file.size)}` })),
            jsonDetails("Attachment source and hashes", plan.files),
          ]),
          "Send these attachments",
        ), isCurrent, runtimeEgress);
        if (!grant || !isCurrent()) {
          if (isCurrent()) feedback.replaceChildren(note("Attachment submission cancelled. Check configuration or confirm cloud egress; the draft is retained.", "warn"));
          return;
        }
        const started = await request("/v1/tasks", post({ ...base, startMode, ...grant }));
        const navigate = isCurrent();
        if (key === selectedKey && input.value === snapshot) { drafts.clear(projectId, null); draft = null; selectedKey = ""; }
        if (navigate) await afterStart(started.taskId, projectId);
        notify(tr("Task started."));
      }
    } catch (error) { if (key === selectedKey) feedback.replaceChildren(note(error.message, "bad")); else notify(error.message, true); }
    finally { busy = false; paintAttachments(); }
  };
  const unsubscribe = client.subscribe(() => {
    operation.options[1].disabled = client.state.run?.status !== "running";
    void bindSelection();
  });
  void bindSelection();
  return {
    refresh: paintAttachments,
    submit() { form.requestSubmit(); },
    reference(value) { input.value += `${input.value && !input.value.endsWith(" ") ? " " : ""}${value} `; persist(); input.focus(); },
    newTask() { persist(); mode = "new"; operation.value = "new"; void bindSelection(); input.focus(); },
    dispose() { persist(); version += 1; uploads.forEach((value) => value.abort()); previews.forEach((value) => URL.revokeObjectURL(value)); unsubscribe(); },
  };
}

const list = (source) => source.split(",").map((value) => value.trim()).filter(Boolean);
