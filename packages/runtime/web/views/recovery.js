import { button, field, jsonDetails, node, note, selectField, tr } from "../components/dom.js";
import { collection, emptyProjection, projectionDetails, servicePage, unavailable, unwrap } from "../components/service.js";
import { post, taskPath } from "../client/api.js";

export function createRecoveryView(host, { taskId, checkpoints = [], request, dialogs, refresh }) {
  if (!taskId) { host.replaceChildren(note("Select a task to resume or compare branches.")); return { dispose() {} }; }
  const base = taskPath(taskId);
  let compareVersion = 0;
  let compareController = null;
  let comparing = false;
  let verificationVersion = 0;
  let verificationController = null;
  let verifying = false;
  let checkpointSignature = "";
  let recordedCheckpoints = checkpoints;
  let resuming = false;
  let primaryStatus;
  let branchPoll = null;
  const terminal = new Set(["proven", "failed", "stopped", "exited_gracefully"]);
  const resumable = new Set(["paused", "executing", "verifying", "auto_repairing", "resuming"]);
  const comparison = node("div", { role: "status", "aria-live": "polite" });
  const verification = node("div", { role: "status", "aria-live": "polite" });
  const checkpoint = selectField("Source checkpoint", "branch-checkpoint", [
    ["", "Select checkpoint"], ...checkpoints.map((entry) => [entry.checkpointId, `${tr(entry.reason ?? "Checkpoint")} · ${entry.checkpointId}`]),
  ], "");
  const label = field("Branch label", "branch-label");
  const left = selectField("Baseline branch", "compare-left", [["", "Select branch"]], "");
  const right = selectField("Candidate branch", "compare-right", [["", "Select branch"]], "");
  async function resumeBranch(entry) {
    if (!resumable.has(entry.status) || resuming || page.resource.state.busy || page.resource.state.stale || page.resource.disposed) return;
    resuming = true;
    try {
      if (!(await dialogs.confirm("Resume branch", node("div", { class: "stack" }, [
        note("The service must validate the ledger, workspace, configuration and artifacts before continuing. Old leases are not reused."),
        jsonDetails("Selected branch", { branchId: entry.branchId, label: entry.label, contract: entry.contract }),
      ]), "Resume branch"))) return;
      if (page.resource.disposed) return;
      const result = await page.resource.mutate(`${base}/resume`, post({ branchId: entry.branchId }));
      if (result && !page.resource.disposed) pollBranch(entry.branchId);
    } finally {
      resuming = false;
      if (!page.resource.disposed && !page.resource.state.error) await page.load();
    }
  }
  function pollBranch(branchId) {
    clearTimeout(branchPoll);
    branchPoll = setTimeout(async () => {
      if (page.resource.disposed) return;
      await page.load();
      const entry = collection(unwrap(page.resource.state.data), "branches", "entries")?.find((row) => row.branchId === branchId);
      if (!page.resource.disposed && !page.resource.state.stale && entry && !terminal.has(entry.status)) pollBranch(branchId);
    }, 2000);
  }
  const resume = button("Resume task", async () => {
    if (!resumable.has(primaryStatus) || resuming || page.resource.state.busy || page.resource.state.stale) return;
    resuming = true;
    try {
      if (!(await dialogs.confirm("Resume task", note("The service must validate the ledger, workspace, configuration and artifacts before continuing. Old leases are not reused."), "Resume task"))) return;
      if (page.resource.disposed || page.resource.state.busy) return;
      resume.disabled = true;
      const result = await page.resource.mutate(`${base}/resume`, post({}));
      if (result && !page.resource.disposed) await refresh?.(taskId);
    } finally {
      resuming = false;
      if (!page.resource.disposed && !page.resource.state.error) await page.load();
    }
  }, "primary");
  const branch = button("Create branch", async () => {
    const input = { checkpointId: checkpoint.input.value, label: label.input.value.trim() };
    if (!input.checkpointId || !input.label || page.resource.state.busy) {
      (input.checkpointId ? label.input : checkpoint.input).focus(); return;
    }
    if (!(await dialogs.confirm("Create branch", node("div", {}, [
      note("A branch needs its own worktree, budget and fresh evidence. The source task is not overwritten."), jsonDetails("Branch request", input),
    ]), "Create branch"))) return;
    if (page.resource.disposed || input.checkpointId !== checkpoint.input.value || input.label !== label.input.value.trim()) return;
    branch.disabled = true;
    try { await page.resource.mutate(`${base}/branches`, post(input)); }
    finally { if (!page.resource.disposed) branch.disabled = false; }
  });
  const verifyBaseline = button("Verify baseline against candidate", async () => {
    if (verifying || page.resource.state.busy || page.resource.state.loading || page.resource.state.stale) return;
    if (!(await dialogs.confirm("Verify baseline against candidate", node("div", { class: "stack" }, [
      note("Keystone will recreate baseline and candidate workspaces and run only protected local checks."),
      note("The result is an observation-only comparison. It does not reuse Proof or create independent Evidence.", "warn"),
    ]), "Run comparison"))) return;
    verificationVersion += 1;
    const selected = verificationVersion;
    verificationController?.abort();
    verificationController = new AbortController();
    const signal = verificationController.signal;
    verifying = true;
    verifyBaseline.disabled = true;
    verification.replaceChildren(note("Running protected baseline and candidate checks"));
    try {
      const report = await request(`${base}/verify-comparison`, {
        ...post({ confirmed: true }),
        signal,
      });
      if (page.resource.disposed || signal.aborted || selected !== verificationVersion) return;
      verification.replaceChildren(
        note(`${tr(report.status ?? "Unknown")} · ${report.verdict ?? tr("Unknown")}`,
          report.status === "observed" ? "ok" : "warn"),
        note("Observation-only comparison; not independent evidence and not a completion decision.", "warn"),
        jsonDetails("Baseline comparison", report),
      );
    } catch (error) {
      if (!page.resource.disposed && !signal.aborted && selected === verificationVersion) {
        verification.replaceChildren(unavailable(error));
      }
    } finally {
      if (!page.resource.disposed && selected === verificationVersion) {
        verifying = false;
        verifyBaseline.disabled = false;
      }
    }
  });
  function invalidateComparison() {
    compareVersion += 1; compareController?.abort(); comparing = false; compare.disabled = false;
    comparison.replaceChildren();
  }
  const compare = button("Compare branches", async () => {
    const baseline = left.input.value; const candidate = right.input.value;
    if (!baseline || !candidate || baseline === candidate) {
      comparison.replaceChildren(note("Choose two different branches to compare.", "warn")); return;
    }
    invalidateComparison();
    const selected = compareVersion;
    compareController = new AbortController(); const signal = compareController.signal;
    comparing = true; compare.disabled = true; comparison.replaceChildren(note("Loading branch comparison"));
    try {
      const result = await request(`${base}/compare?${new URLSearchParams({ left: baseline, right: candidate })}`, { signal });
      if (page.resource.disposed || signal.aborted || selected !== compareVersion) return;
      if (result?.supported === false || result?.error) throw Object.assign(new Error(result.reason ?? result.error ?? "Capability unavailable."), { status: 501, body: result });
      const data = unwrap(result);
      comparison.replaceChildren(node("h3", { text: tr("Branch comparison") }), note("Comparison is a server observation, not new independent evidence."));
      for (const [key, title] of [["changes", "Changes"], ["budget", "Budget comparison"], ["proof", "Proof comparison"], ["diff", "Changes"]]) {
        if (data?.[key] != null) comparison.append(jsonDetails(title, data[key]));
      }
      comparison.append(jsonDetails("Comparison response", result));
    } catch (error) {
      if (!page.resource.disposed && !signal.aborted && selected === compareVersion) comparison.replaceChildren(unavailable(error));
    } finally {
      if (!page.resource.disposed && selected === compareVersion) { comparing = false; compare.disabled = false; }
    }
  });
  left.input.onchange = invalidateComparison; right.input.onchange = invalidateComparison;
  const page = servicePage(host, {
    title: "Recovery and branches", description: "Continue a verified checkpoint or compare independent execution branches.",
    path: `${base}/branches`, request,
    render(body, state) {
      body.replaceChildren();
      const data = unwrap(state.data);
      if (!data) return;
      const branches = collection(data, "branches", "entries");
      const primary = branches?.find((entry) => entry.label === "primary" && !entry.forkedFromBranchId);
      primaryStatus = primary?.status;
      resume.disabled = state.busy || state.loading || state.stale || resuming || !resumable.has(primaryStatus);
      for (const control of [left.input, right.input]) {
        const selected = control.value;
        control.replaceChildren(node("option", { value: "", text: tr("Select branch") }), ...(branches ?? []).map((entry) => node("option", {
          value: entry.branchId ?? entry.id, text: entry.label ?? entry.branchId ?? entry.id,
        })));
        control.value = selected;
        if (selected && !(branches ?? []).some((entry) => (entry.branchId ?? entry.id) === selected)) { control.value = ""; invalidateComparison(); }
      }
      compare.disabled = comparing || state.busy || state.loading || state.stale || !branches?.length;
      verifyBaseline.disabled = verifying || state.busy || state.loading || state.stale;
      for (const entry of branches ?? []) {
        const action = button("Resume branch", () => resumeBranch(entry));
        action.disabled = resuming || state.busy || state.loading || state.stale || !resumable.has(entry.status);
        body.append(node("article", { class: "record-row" }, [
          node("h3", { text: entry.label ?? entry.branchId ?? entry.id ?? tr("Unknown") }),
          note(tr(entry.status ?? "Unknown")),
          ...(entry.contract ? [jsonDetails("Branch contract", entry.contract)] : []),
          ...(entry.proof ? [jsonDetails("Branch proof", entry.proof)] : []),
          projectionDetails(entry),
          ...(entry.forkedFromBranchId ? [action] : []),
        ]));
      }
      if (branches === null || !branches.length) emptyProjection(body, null, branches, "No branches recorded for this task.");
      if (state.result) body.append(jsonDetails("Recovery result", state.result));
      body.append(jsonDetails("Service response", state.data));
    },
  });
  page.controls.append(node("div", { class: "recovery-controls stack" }, [
    resume, verifyBaseline, verification,
    node("div", { class: "form-columns" }, [checkpoint.wrap, label.wrap]), branch,
    node("div", { class: "form-columns" }, [left.wrap, right.wrap]), compare, comparison,
  ]));
  const checkpointNotice = note("No checkpoints are available. Branch creation requires a recorded checkpoint.", "warn");
  page.controls.append(checkpointNotice);
  function update(next = recordedCheckpoints) {
    const signature = JSON.stringify(next);
    if (signature === checkpointSignature) return;
    checkpointSignature = signature; recordedCheckpoints = next;
    const selected = checkpoint.input.value;
    checkpoint.input.replaceChildren(node("option", { value: "", text: tr("Select checkpoint") }),
      ...next.map((entry) => node("option", { value: entry.checkpointId, text: `${tr(entry.reason ?? "Checkpoint")} · ${entry.checkpointId}` })));
    checkpoint.input.value = next.some((entry) => entry.checkpointId === selected) ? selected : "";
    checkpointNotice.hidden = next.length > 0;
    branch.disabled = !next.length;
  }
  update(checkpoints);
  void page.load();
  return { update, load: page.load, dispose() {
    clearTimeout(branchPoll);
    compareVersion += 1; compareController?.abort();
    verificationVersion += 1; verificationController?.abort();
    page.dispose();
  } };
}
