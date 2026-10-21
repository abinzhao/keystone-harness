import { button, field, jsonDetails, node, note, selectField, tr } from "../components/dom.js";
import { collection, emptyProjection, projectionDetails, servicePage, unwrap } from "../components/service.js";
import { post } from "../client/api.js";
import { parsePublicJson } from "../state/collaboration.js";

export function createCollaborationView(host, { request, dialogs = {}, afterAdopt }) {
  let inputVersion = 0;
  let localBusy = false;
  let reviewed = null;
  let sources = [];
  let sourcesProject = "";
  let sourceVersion = 0;
  const sending = new Set();
  const transportControllers = new Set();
  const resultHost = node("div", { role: "status", "aria-live": "polite" });
  const project = selectField("Local project", "collaboration-project", [], "");
  const peerId = field("Peer identity", "collaboration-peer-id");
  const peerKey = field("Peer public Ed25519 key (PEM)", "collaboration-peer-key", "", "textarea");
  const peerEndpoint = field("Declared peer endpoint (optional)", "collaboration-peer-endpoint");
  const taskId = selectField("Local task", "collaboration-task-id", [], "");
  const branchId = field("Branch ID (optional)", "collaboration-branch-id");
  const recoveryFiles = field("Include workspace recovery source files", "collaboration-recovery-files", "", "checkbox");
  const adoptRequest = field("Fresh local task request", "collaboration-adopt-request", "", "textarea");
  const candidate = selectField("Local rule or experience", "collaboration-candidate", [], "");
  const sourceDetails = node("div");
  const recipient = selectField("Pinned recipient", "collaboration-recipient", [], "");
  const endpointDetails = node("div");
  const scope = field("Child scope (one relative path per line)", "collaboration-scope", "", "textarea");
  const instruction = field("Public instruction", "collaboration-instruction", "", "textarea");
  const maxTokens = field("Token ceiling", "collaboration-max-tokens", "1000", "number");
  const maxBytes = field("Byte ceiling", "collaboration-max-bytes", "16384", "number");
  const maxMs = field("Time ceiling (milliseconds)", "collaboration-max-ms", "10000", "number");
  const signed = field("Signed document (JSON, no secrets)", "collaboration-signed", "", "textarea");
  const expected = field("Expected binding (JSON)", "collaboration-expected", "", "textarea");
  const root = field("Portable package root", "collaboration-root");
  const data = () => unwrap(page.resource.state.data) ?? {};
  const selectedProject = () => {
    if (!(data().projects ?? []).some((p) => p.projectId === project.input.value && p.status === "available" && !p.archived)) {
      throw new Error("Select an available local project.");
    }
    return project.input.value;
  };
  function showError(error) {
    if (page.resource.disposed) return;
    resultHost.replaceChildren(note(error?.body?.reason ?? error?.message ?? "The request failed. No change is confirmed.", "bad"),
      ...(error?.body ? [jsonDetails("Service refusal", error.body)] : []));
  }
  function showSource() {
    const selected = sources.find((s) => s.sourceId === candidate.input.value);
    sourceDetails.replaceChildren(selected ? projectionDetails(selected) : note("No local shareable source selected."));
  }
  async function loadSources() {
    const id = project.input.value; const version = ++sourceVersion;
    sourcesProject = id; sources = []; candidate.input.replaceChildren(); showSource(); syncControls();
    if (!id) return;
    try {
      const result = unwrap(await request(`/v1/collaboration/sources/${encodeURIComponent(id)}`));
      if (page.resource.disposed || version !== sourceVersion || id !== project.input.value) return;
      if (!Array.isArray(result?.sources)) throw new Error("Local sharing source listing is unavailable.");
      sources = result.sources;
      candidate.input.replaceChildren(...sources.map((s) => node("option", {
        value: s.sourceId, text: `${s.kind}: ${s.statement.slice(0, 100)}`,
      })));
      candidate.input.value = sources[0]?.sourceId ?? ""; showSource();
    } catch (error) {
      if (!page.resource.disposed && version === sourceVersion) sourceDetails.replaceChildren(note(error.body?.reason ?? error.message, "warn"));
    } finally { if (!page.resource.disposed) syncControls(); }
  }
  const initialize = button("Initialize local exchange", () => action("Initialize local exchange", "/initialize", () => ({
    projectId: selectedProject(),
  }), "Create the local exports, inbox and quarantine directories through a dedicated fs.write lease. No package is imported or sent."));
  async function action(label, path, build, message, onResult, effect = true) {
    if (localBusy || page.resource.state.busy || page.resource.state.loading || page.resource.state.stale || page.resource.disposed) return;
    const selected = inputVersion;
    localBusy = true; syncControls();
    try {
      const input = parsePublicJson(JSON.stringify(build()));
      if (!(await dialogs.confirm?.(label, node("div", {}, [note(message), jsonDetails("Requested local operation", input)]), label))) return;
      if (page.resource.disposed || selected !== inputVersion) return;
      const result = await page.resource.mutate(`/v1/collaboration${path}`, post(effect ? { ...input, confirmed: true } : input));
      if (page.resource.disposed || selected !== inputVersion) return;
      if (!result) { showError(page.resource.state.error); return; }
      await onResult?.(result, input);
      resultHost.replaceChildren(note("Local operation recorded; trust and task completion are unchanged."),
        jsonDetails(label, result));
    } catch (error) { showError(error); }
    finally { localBusy = false; if (!page.resource.disposed) render(page.body, page.resource.state); }
  }
  const pin = button("Pin public peer", () => action("Pin public peer", "/peers/register", () => ({
    projectId: selectedProject(), identityId: peerId.input.value.trim(), publicKey: peerKey.input.value.trim(),
    ...(peerEndpoint.input.value.trim() ? { endpoint: peerEndpoint.input.value.trim() } : {}),
  }), "Pin only a public identity and declared endpoint. Key possession does not grant trust, permissions or network access."));
  const exportTask = button("Export local task", () => action("Export local task", "/export", () => ({
    projectId: selectedProject(), taskId: taskId.input.value.trim(),
    ...(branchId.input.value.trim() ? { branchId: branchId.input.value.trim() } : {}),
    ...(recoveryFiles.input.checked ? { includeRecoveryWorkspace: true } : {}),
  }), "Write the complete ledger and referenced artifacts under local exports. Recovery source files require the separate checkbox; no data is sent over the network. Inspect the package before sharing.",
  (result) => {
    root.input.value = result.root; reviewed = null;
    if (result.signature) signed.input.value = JSON.stringify(result.signature, null, 2);
  }));
  const verify = button("Verify signature", () => action("Verify signature", "/verify", () => ({
    signed: parsePublicJson(signed.input.value), expected: parsePublicJson(expected.input.value),
  }), "Only public signed content is sent to the local verification service. Integrity does not prove completion or elevate trust.", undefined, false));
  const preview = button("Preview portable package", () => action("Preview portable package", "/preview", () => {
    const path = root.input.value.trim();
    if (!path) throw new Error("Enter a portable package root.");
    reviewed = null;
    return { root: path };
  }, "This reads and validates an admitted local bundle only. No files are imported and no task is executed.",
  (result) => { if (result.digest) reviewed = { root: root.input.value.trim(), digest: result.digest }; }, false));
  const importPackage = button("Import reviewed package", () => action("Import reviewed package", "/import", () => {
    if (!reviewed || reviewed.root !== root.input.value.trim()) throw new Error("Preview the unchanged package before importing.");
    return { projectId: selectedProject(), ...reviewed };
  }, "Copy exactly the reviewed bytes into local untrusted quarantine. No imported ledger, lease, Evidence or completion becomes authoritative."));
  const share = button("Preview shared candidate", () => action("Preview shared candidate", "/share", () => {
    const selected = sources.find((s) => s.sourceId === candidate.input.value);
    if (!selected || sourcesProject !== project.input.value) throw new Error("Refresh and select a local sharing source.");
    return { projectId: selectedProject(), sourceId: selected.sourceId, sourceDigest: selected.sourceDigest };
  }, "Reuse the actual local source statement and upstream provenance; compare conflicts without promoting or sending it. The service rejects changed source digests."));
  const prepare = button("Prepare bounded delegation", () => action("Prepare bounded delegation", "/delegation/prepare", () => {
    const peer = (data().peers ?? []).find((p) => p.identityId === recipient.input.value && !p.revoked && p.endpoint);
    if (!peer) throw new Error("Pin an unrevoked public peer with a declared endpoint first.");
    if (!instruction.input.value.trim()) throw new Error("Enter a public instruction.");
    return { projectId: selectedProject(), recipientId: peer.identityId, endpoint: peer.endpoint,
      scopePaths: scope.input.value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
      budget: { maxTokens: Number(maxTokens.input.value), maxBytes: Number(maxBytes.input.value), maxWallClockMs: Number(maxMs.input.value) },
      parameters: { instruction: instruction.input.value.trim() } };
  }, "Create and sign a bounded request in a dedicated parent task. No network IO occurs. Sending needs a separate explicit decision."));

  async function send(entry) {
    if (sending.has(entry.delegationId) || localBusy || page.resource.state.busy || page.resource.state.stale || page.resource.disposed) return;
    const selected = inputVersion;
    sending.add(entry.delegationId); render(page.body, page.resource.state);
    const controller = new AbortController(); transportControllers.add(controller);
    try {
      if (!(await dialogs.confirm?.("Send prepared delegation", node("div", {}, [
        note("Opt in to one network POST to the pinned endpoint, within the signed scope and budget. Remote claims remain untrusted observations, never Proof."),
        jsonDetails("Prepared request binding", entry),
      ]), "Send prepared delegation"))) return;
      if (page.resource.disposed || selected !== inputVersion) return;
      resultHost.replaceChildren(note("Delegation transport is pending. Stop remains available; no completion is claimed."));
      // Transport waits must not occupy the service mutation lock used by Stop.
      const result = await request("/v1/collaboration/delegate", {
        ...post({ delegationId: entry.delegationId, digest: entry.digest, confirmed: true }), signal: controller.signal,
      });
      if (!page.resource.disposed) resultHost.replaceChildren(jsonDetails("Delegation observation", result));
    } catch (error) { showError(error); }
    finally {
      sending.delete(entry.delegationId); transportControllers.delete(controller);
      if (!page.resource.disposed) await page.load();
    }
  }
  function syncControls() {
    const state = page.resource.state;
    const blocked = localBusy || state.busy || state.loading || state.stale;
    const available = (data().projects ?? []).some((p) => p.projectId === project.input.value && p.status === "available" && !p.archived);
    verify.disabled = preview.disabled = blocked;
    initialize.disabled = blocked || !available || data().initializationAvailable !== true;
    pin.disabled = blocked || !available;
    exportTask.disabled = blocked || !available || !taskId.input.value;
    share.disabled = blocked || !available || sourcesProject !== project.input.value || !sources.some((s) => s.sourceId === candidate.input.value);
    importPackage.disabled = blocked || !available || data().importAvailable !== true || !reviewed || reviewed.root !== root.input.value.trim();
    prepare.disabled = blocked || !available || data().delegation?.outboundAvailable !== true;
  }
  function render(body, state) {
    body.replaceChildren();
    const projection = unwrap(state.data);
    if (!projection) { syncControls(); return; }
    const projects = (projection.projects ?? []).filter((p) => p.status === "available" && !p.archived);
    const previous = project.input.value;
    project.input.replaceChildren(...projects.map((p) => node("option", { value: p.projectId, text: p.name ?? p.projectId })));
    project.input.value = projects.some((p) => p.projectId === previous) ? previous : projects[0]?.projectId ?? "";
    if (previous && previous !== project.input.value) { inputVersion++; reviewed = null; }
    const taskIds = projects.find((p) => p.projectId === project.input.value)?.tasks ?? [];
    const previousTask = taskId.input.value;
    taskId.input.replaceChildren(...taskIds.map((id) => node("option", { value: id, text: id })));
    taskId.input.value = taskIds.includes(previousTask) ? previousTask : taskIds[0] ?? "";
    const peers = (projection.peers ?? []).filter((p) => !p.revoked && p.endpoint);
    const previousRecipient = recipient.input.value;
    recipient.input.replaceChildren(...peers.map((p) => node("option", { value: p.identityId, text: p.identityId })));
    recipient.input.value = peers.some((p) => p.identityId === previousRecipient) ? previousRecipient : peers[0]?.identityId ?? "";
    endpointDetails.replaceChildren(note(peers.find((p) => p.identityId === recipient.input.value)?.endpoint ??
      "No unrevoked peer with a declared endpoint."));
    syncControls();
    if (sourcesProject !== project.input.value) void loadSources();
    body.append(note("Signatures and imports never raise trust. Foreign completion is not a local completion decision."));
    if (projection.identity) body.append(jsonDetails("Session-only public identity", projection.identity));
    if (projection.roots) body.append(jsonDetails("Admitted package roots", projection.roots));
    if (projection.retention) body.append(note(projection.retention));
    if (projection.importAvailable === false) body.append(note("Portable import is unavailable: no parent kernel admission is configured.", "warn"));
    if (projection.adoptionAvailable === false) body.append(note(projection.candidateAdoptionReason ??
      "Trust-preserving candidate promotion is unavailable. Shared candidates remain untrusted.", "warn"));
    if (projection.delegation?.outboundAvailable === false) body.append(note("Remote delegation is unavailable: no outbound lease hook is configured.", "warn"));
    const blocked = localBusy || state.busy || state.loading || state.stale;
    const hasProject = !!project.input.value;
    for (const peer of projection.peers ?? []) {
      const revoke = button("Revoke peer", () => action("Revoke peer", "/peers/revoke", () => ({
        projectId: selectedProject(), identityId: peer.identityId,
      }), "Revoke this pinned peer and stop its pending local delegations."));
      revoke.disabled = blocked || !hasProject || peer.revoked;
      body.append(node("article", { class: "record-row" }, [
        node("h3", { text: peer.identityId }), note(peer.revoked ? "Revoked" : "Pinned public peer; untrusted"),
        ...(peer.endpoint ? [node("code", { text: peer.endpoint })] : []), projectionDetails(peer), revoke,
      ]));
    }
    for (const entry of projection.imports ?? []) {
      const adopt = button("Create fresh local draft", () => action("Create fresh local draft", "/adopt-task", () => ({
        projectId: selectedProject(), importId: entry.importId, digest: entry.digest, request: adoptRequest.input.value.trim(),
      }), "Create only a new local draft with an untrusted source reference. No old Contract, permissions, Evidence or completion is adopted.",
      async (result, input) => afterAdopt?.(result, { projectId: input.projectId, request: input.request })));
      adopt.disabled = blocked || !hasProject || projection.taskAdoptionAvailable !== true || !!entry.adoptedTaskId;
      body.append(node("article", { class: "record-row" }, [
        node("h3", { text: entry.importId ?? entry.taskId }), projectionDetails(entry), adopt,
      ]));
    }
    for (const entry of projection.delegations ?? []) {
      const sendButton = button("Send prepared delegation", () => send(entry));
      sendButton.disabled = blocked || entry.status !== "prepared" || sending.has(entry.delegationId);
      const stop = button("Stop delegation", () => action("Stop delegation", "/delegation/stop", () => ({
        delegationId: entry.delegationId,
      }), "Abort the local transport and fence further observations. This does not prove that a remote peer rolled back its effects."));
      stop.disabled = blocked || !["prepared", "sending"].includes(entry.status);
      body.append(node("article", { class: "record-row" }, [
        node("h3", { text: entry.delegationId ?? entry.taskId }), note(entry.status ?? "Unknown"),
        projectionDetails(entry), node("div", { class: "row" }, [sendButton, stop]),
      ]));
    }
    for (const entry of collection(projection, "candidates", "shared") ?? []) {
      body.append(node("article", { class: "record-row" }, [
        node("h3", { text: entry.key ?? entry.candidateId }), projectionDetails(entry),
        note("Candidate retained as untrusted. Project promotion is not supported.", "warn"),
      ]));
    }
    body.append(jsonDetails("Service response", state.data));
  }
  const page = servicePage(host, {
    title: "Collaboration", description: "External signatures, imports and delegations never raise evidence trust or expand local permissions.",
    path: "/v1/collaboration", request, render,
  });
  const invalidate = () => { inputVersion++; reviewed = null; resultHost.replaceChildren(); syncControls(); };
  project.input.addEventListener("change", () => { invalidate(); render(page.body, page.resource.state); });
  for (const control of [peerId, peerKey, peerEndpoint, taskId, branchId, recoveryFiles, adoptRequest, candidate, recipient, scope, instruction, maxTokens, maxBytes, maxMs, signed, expected, root]) {
    control.input.addEventListener("input", invalidate);
  }
  taskId.input.addEventListener("change", invalidate);
  candidate.input.addEventListener("change", () => { invalidate(); showSource(); });
  recipient.input.addEventListener("change", () => { invalidate(); render(page.body, page.resource.state); });
  const section = (title, children) => node("section", { class: "stack" }, [node("h3", { text: tr(title) }), ...children]);
  const controlTabs = node("nav", { class: "segmented", "aria-label": tr("Collaboration workflows") });
  const controlTabButtons = [];
  const panels = {
    packages: section("Portable tasks", [
      node("div", { class: "form-columns" }, [taskId.wrap, branchId.wrap]),
      recoveryFiles.wrap,
      node("div", { class: "row" }, [exportTask, preview, importPackage]),
      root.wrap,
      adoptRequest.wrap,
      note("Use a package directory inside exports or inbox. Imported drafts must be submitted and verified independently."),
    ]),
    peers: section("Public peers", [
      node("div", { class: "form-columns" }, [peerId.wrap, peerEndpoint.wrap]),
      peerKey.wrap,
      pin,
    ]),
    delegation: section("Bounded delegation", [
      recipient.wrap, endpointDetails,
      node("div", { class: "form-columns" }, [scope.wrap, instruction.wrap]),
      node("div", { class: "row collaboration-budget" }, [maxTokens.wrap, maxBytes.wrap, maxMs.wrap]),
      prepare,
      note("Use 0-100000 tokens, 4096-1048576 bytes and 100-60000 milliseconds. Only keystone.delegation/1 is supported; this is not general A2A compatibility."),
    ]),
    verification: section("Verification and sharing", [
      node("details", {}, [node("summary", { text: tr("Verify public signatures") }),
        note("The expected binding must come from a local trusted source, not from the signed envelope."),
        signed.wrap, expected.wrap, verify]),
      node("details", {}, [node("summary", { text: tr("Share rules and experience") }),
        candidate.wrap, button("Refresh local sharing sources", loadSources), sourceDetails, share,
        note("Source identity, statement, digest and provenance come from local records. No trust-preserving promotion is available.")]),
    ]),
  };
  const selectControlTab = (selected) => {
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== selected;
    for (const [key, item] of controlTabButtons) item.setAttribute("aria-pressed", String(key === selected));
  };
  for (const [key, label] of [["packages", "Portable tasks"], ["peers", "Public peers"],
    ["delegation", "Bounded delegation"], ["verification", "Verification and sharing"]]) {
    const item = button(label, () => selectControlTab(key));
    controlTabButtons.push([key, item]);
    controlTabs.append(item);
  }
  page.controls.append(node("div", { class: "collaboration-controls stack" }, [
    note("Public content only. Never enter credentials or private keys."),
    node("div", { class: "collaboration-project-row" }, [project.wrap, initialize]),
    controlTabs,
    ...Object.values(panels),
    resultHost,
  ]));
  selectControlTab("packages");
  const dispose = page.dispose;
  page.dispose = () => {
    for (const controller of transportControllers) controller.abort();
    dispose();
  };
  void page.load(); return page;
}

export function createReadinessView(host, { request }) {
  const page = servicePage(host, {
    title: "Release readiness", description: "Local checks, third-party interoperability and production release gates are separate evidence.",
    path: "/v1/release/readiness", request,
    render(body, state) {
      body.replaceChildren();
      const data = unwrap(state.data)?.readiness ?? unwrap(state.data);
      if (!data) return;
      body.append(note("No deployment, signing or notarization is performed by this page. Missing evidence is not a passed gate."));
      if (data.status || data.version || data.releaseVersion) body.append(node("p", { text: [data.releaseVersion ?? data.version, data.channel, data.status].filter(Boolean).join(" · ") }));
      if (typeof data.localReady === "boolean") body.append(note(data.localReady ? "Local checks ready; stable release is evaluated separately." : "Local checks not ready.", data.localReady ? "ok" : "warn"));
      if (typeof data.stableReady === "boolean") body.append(note(data.stableReady ? "Stable gates reported ready; release still requires explicit approval." : "Stable release not ready.", data.stableReady ? "ok" : "warn"));
      const gates = collection(data, "gates", "checks", "items");
      for (const gate of gates ?? []) {
        body.append(node("article", { class: "record-row" }, [
          node("h3", { text: gate.name ?? gate.title ?? gate.gateId ?? gate.id ?? tr("Release gate") }),
          node("p", { class: "muted", text: [gate.status ?? (gate.passed === true ? tr("Passed") : gate.passed === false ? tr("Not passed") : tr("Unknown")), gate.reason ?? gate.detail].filter(Boolean).join(" · ") }),
          projectionDetails(gate),
        ]));
      }
      if (gates === null || !gates.length) emptyProjection(body, null, gates, "No release gate evidence returned.");
      body.append(jsonDetails("Service response", state.data));
    },
  });
  void page.load(); return page;
}
