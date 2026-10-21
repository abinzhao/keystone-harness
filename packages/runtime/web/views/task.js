import { button, node, tr, text, esc, kv, note, jsonDetails, statusTone, bytes } from "../components/dom.js";
import { post, taskPath } from "../client/api.js";

const STAGES = ["understanding", "planning", "authorizing", "modifying", "verifying", "delivering"];
const TERMINAL = new Set(["proven", "exited_gracefully", "failed", "stopped", "unrecoverable"]);
const EVENTS = {
  "task.created": "Task created", "task.started": "Task started", "task.paused": "Paused", "task.stopped": "Stopped",
  "contract.compiled": "Contract compiled", "contract.revised": "Contract revised", "action.proposed": "Action proposed",
  "action.executed": "Action executed", "action.rejected": "Action refused", "lease.issued": "Lease issued",
  "scope.violation_detected": "Scope violation", "workspace.conflict_detected": "Workspace conflict",
  "checkpoint.created": "Checkpoint", "branch.created": "Branch forked", "verification.started": "Verification started",
  "verification.failed": "Verification failed", "evidence.recorded": "Evidence recorded", "evidence.invalidated": "Evidence invalidated",
  "proof.satisfied": "Proof satisfied", "proof.invalidated": "Proof invalidated", "proof.evaluated": "Proof evaluated",
  "intervention.requested": "Waiting for you", "intervention.decided": "Decision recorded", "budget.consumed": "Budget consumed",
  "context.plan_created": "Context plan", "error.recorded": "Error recorded", "degradation.applied": "Degradation applied",
};

export function proofIsCurrent(state) {
  return state.connection === "connected" && state.proof?.outcome === "proven" && !state.detail?.proofInvalidated;
}

export function renderOverview(host, state) {
  const detail = state.detail;
  if (!detail) {
    host.replaceChildren(node("div", { class: "empty" }, [
      node("h2", { text: tr(state.loading ? "Loading task" : "A workspace for verifiable work") }),
      node("p", { text: tr("Select a project, describe an outcome, then review changes and independent evidence.") }),
    ]));
    return;
  }
  const contract = detail.contract;
  host.innerHTML = `<div class="stack">
    <div><span class="eyebrow">${text("Goal and scope")}</span><h3>${esc(contract?.goal ?? tr("No contract yet."))}</h3></div>
    <div class="row"><span class="pill ${statusTone(detail.status)}">${text(detail.status)}</span><span class="chip">${text("contract v{version}", { version: contract?.version ?? "?" })}</span><span class="chip">${text(detail.replay?.consistent ? "replay consistent" : "replay inconsistent")}</span></div>
    <div class="stage-list">${STAGES.map((stage) => `<span class="${stage === detail.stage ? "active" : ""}">${text(`stage-${stage}`)}</span>`).join("")}</div>
    <div><h2>${text("Write scope")}</h2><div class="row">${(contract?.writeScope ?? []).map((value) => `<code class="chip">${esc(value)}</code>`).join("") || text("(nothing writable)")}</div></div>
    <div><h2>${text("Read scope")}</h2><div class="row">${(contract?.readScope ?? []).map((value) => `<code class="chip">${esc(value)}</code>`).join("") || text("none")}</div></div>
    <div><h2>${text("Completion conditions")}</h2><div id="overview-conditions"></div></div>
    <div><h2>${text("Invariants")}</h2><ul>${(contract?.invariants ?? []).map((value) => `<li>${esc(value.description)}</li>`).join("")}</ul></div>
  </div>`;
  const verdicts = new Map((state.proof?.conditions ?? []).map((entry) => [entry.conditionId, entry]));
  for (const condition of contract?.completionConditions ?? []) {
    const result = verdicts.get(condition.conditionId);
    const wrap = node("details", { class: "condition" });
    wrap.append(node("summary", {}, [
      node("span", { class: `pill ${result?.satisfied && state.connection === "connected" ? "ok" : "warn"}`, text: tr(state.connection !== "connected" ? "Stale" : result?.satisfied ? "satisfied" : result?.reasonCode ?? "not evaluated") }),
      node("span", { text: condition.description }),
    ]));
    wrap.append(node("p", { class: "muted", text: `${tr(condition.required ? "required" : "auxiliary")} · ${condition.minEvidenceLevel} · ${condition.verifier} · ${tr(condition.requiresIndependence ? "independent: yes" : "independent: no")}` }));
    wrap.append(jsonDetails("Condition and admission", { condition, result: result ?? null }));
    host.querySelector("#overview-conditions").append(wrap);
  }
  if (detail.ledger?.integrityOk === false) host.prepend(note(tr("Ledger integrity check failed: {reason}", { reason: detail.ledger.integrityReason }), "bad"));
  if (detail.degradation) host.prepend(note(tr("Degraded to {mode}: {reason}", detail.degradation), "warn"));
  if (TERMINAL.has(detail.status)) {
    const receipt = node("div", { id: "receipt", class: "notice" });
    receipt.append(node("h2", { text: tr(proofIsCurrent(state) ? "Safe to deliver" : "The task finished, but its proof is not complete.") }));
    const required = (state.proof?.conditions ?? []).filter((entry) => entry.required);
    const known = state.proof?.changes;
    receipt.append(node("p", { text: `${tr("Required conditions")}: ${required.filter((entry) => entry.satisfied).length}/${required.length} · ${tr("Changed files")}: ${known?.changedFileCount ?? tr("Unknown")}` }));
    host.prepend(receipt);
  }
  if (contract) host.append(jsonDetails("Contract, permissions and budget", contract));
  if (detail.attachments?.length) {
    host.append(node("h2", { text: tr("Task input attachments") }));
    for (const attachment of detail.attachments) host.append(node("p", { text: `${attachment.name} · ${attachment.mimeType} · ${bytes(attachment.size)}` }));
    host.append(jsonDetails("Attachment source and hashes", detail.attachments));
  }
  if (detail.configurationSnapshot) host.append(jsonDetails("Task configuration snapshot", detail.configurationSnapshot));
}

export function renderTrace(host, state, preferences) {
  if (!host.querySelector("#trace-events")) {
    const search = node("input", { id: "trace-search", type: "search", placeholder: tr("Search trace"), "aria-label": tr("Search trace") });
    search.value = preferences.search ?? "";
    const all = node("input", { id: "trace-all", type: "checkbox" });
    all.checked = !!preferences.all;
    const label = node("label", { for: "trace-all", class: "row" }, [all, tr("show raw events")]);
    const events = node("div", { id: "trace-events" });
    const refresh = () => { preferences.search = search.value; preferences.all = all.checked; paint(); };
    search.oninput = refresh; all.onchange = refresh;
    host.replaceChildren(node("div", { class: "row" }, [search, label]), events);
  }
  const paint = () => {
    const container = host.querySelector("#trace-events");
    const quiet = new Set(["lease.issued", "lease.consumed", "budget.consumed", "context.plan_created"]);
    const events = state.events.filter((event) => (preferences.all || !quiet.has(event.type)) && `${event.type} ${JSON.stringify(event.payload)}`.toLocaleLowerCase().includes((preferences.search ?? "").toLocaleLowerCase()));
    container.replaceChildren();
    if (events.length > 100) container.append(note(tr("Showing latest {count} events. Filter to inspect earlier events.", { count: 100 })));
    for (const event of events.slice(-100).reverse()) {
      const p = event.payload ?? {};
      const item = node("div", { class: "event" }, [
        node("div", { class: "event-head" }, [node("small", { text: `#${event.seq}` }), node("strong", { text: tr(EVENTS[event.type] ?? event.type) }), node("time", { text: event.at ? new Date(event.at).toLocaleTimeString() : "" })]),
        node("p", { class: "muted", text: p.reason ?? p.detail ?? p.rationale ?? p.question ?? p.goal ?? p.message ?? (p.changedPaths ?? []).join(", ") }),
        jsonDetails("Parameters, source and output", { actor: event.actor, type: event.type, payload: p }),
      ]);
      container.append(item);
    }
    if (!events.length) container.append(note("No events yet."));
  };
  paint();
}

export function renderCommands(host, state) {
  host.replaceChildren(node("h2", { text: tr("Command receipts") }), note("Recorded commands only. Execution requires a kernel-issued lease; viewing output does not verify a condition."));
  const proposals = new Map(state.events.filter((event) => event.type === "action.proposed").map((event) => [event.payload?.proposalId, event.payload]));
  const leases = new Map(state.events.filter((event) => event.type === "lease.issued").map((event) => [event.payload?.leaseId, event.payload]));
  let count = 0;
  for (const event of state.events.filter((entry) => entry.type === "action.executed").reverse()) {
    const result = event.payload;
    const proposal = proposals.get(result.proposalId);
    if (proposal?.tool?.id !== "cmd.run" && !proposal?.tool?.id?.includes("shell") && !proposal?.tool?.id?.includes("command")) continue;
    count += 1;
    const lease = leases.get(result.leaseId);
    const receipt = node("details", {}, [
      node("summary", { text: `${proposal.tool.id} · ${result.status} · ${tr("Exit code")}: ${result.exitCode ?? tr("Unknown")}` }),
      jsonDetails("Command, environment and lease", { proposal, lease: lease ?? null, result }),
      node("pre", { text: result.stdout ?? result.stderr ?? tr("Output content is not exposed by this API. Artifact: {artifact}, {size}.", { artifact: result.outputArtifactId ?? tr("none"), size: bytes(result.outputBytes) }) }),
    ]);
    host.append(receipt);
  }
  if (!count) host.append(note("No command executions recorded."));
  if (state.proof?.reproduceCommands?.length) host.append(node("h3", { text: tr("Reproduce commands") }), node("pre", { text: state.proof.reproduceCommands.join("\n") }));
}

export function renderInspector(state, { request, dialogs, refresh, drafts }) {
  const host = document.getElementById("proof-summary");
  const proof = state.proof;
  const detail = state.detail;
  host.replaceChildren();
  const current = proofIsCurrent(state);
  const required = (proof?.conditions ?? []).filter((entry) => entry.required);
  host.append(node("section", {}, [
    node("h3", { class: current ? "ok" : "warn", text: tr(current ? "Safe to deliver" : state.connection === "stale" ? "Stale proof; reconnect to verify" : detail?.proofInvalidated ? "Current proof invalidated" : "Not provable yet") }),
    node("p", { class: "muted", text: `${tr("Required conditions")}: ${required.filter((entry) => entry.satisfied).length}/${required.length}` }),
  ]));
  if (detail?.proofInvalidated) host.append(note(detail.proofInvalidated.reason, "warn"));
  if (proof) {
    const metadata = node("dl");
    metadata.innerHTML = kv("Outcome", proof.outcome) + kv("In scope", proof.changes?.withinScope == null ? tr("Unknown") : tr(proof.changes.withinScope ? "yes" : "no")) + kv("Generated", proof.generatedAt);
    host.append(metadata);
    for (const [key, values] of [["Unverified", proof.unverified], ["Residual risks", proof.residualRisks]]) {
      if (values?.length) host.append(node("h4", { text: tr(key) }), node("ul", {}, values.map((value) => node("li", { text: value }))));
    }
    host.append(jsonDetails("Proof and provenance", proof));
  } else host.append(note("No proof yet."));

  const decisions = document.getElementById("decisions");
  const interventions = state.run?.pendingInterventions ?? [];
  const signature = `${state.taskId}:${interventions.map((entry) => entry.interventionId).join(",")}`;
  // Polling must not destroy a rationale the user is currently typing.
  if (decisions.dataset.signature !== signature) {
    decisions.dataset.signature = signature;
    decisions.replaceChildren();
    if (!interventions.length) decisions.append(note("Nothing waiting."));
    for (const intervention of interventions) {
      const taskId = state.taskId;
      const projectId = state.projectId;
      const saved = drafts.get(projectId, taskId);
      const rationale = node("textarea", { id: `reason-${intervention.interventionId}`, rows: 2 });
      rationale.value = saved[`decision-${intervention.interventionId}`] ?? "";
      rationale.oninput = () => {
        rationale.setCustomValidity("");
        drafts.set(projectId, taskId, { [`decision-${intervention.interventionId}`]: rationale.value });
      };
      const item = node("div", { class: "decision" }, [
        node("h3", { text: intervention.question }),
        node("p", { class: "muted", text: tr("Why you: {text}", { text: intervention.whyUserNeeded }) }),
        node("p", { class: "muted", text: tr("If ignored: {text}", { text: intervention.ifIgnoredImpact }) }),
        jsonDetails("Context and requested permissions", intervention),
        node("label", { for: rationale.id, text: tr("Decision rationale") }), rationale,
      ]);
      const controls = node("div", { class: "row" });
      for (const decision of ["allow", "deny"]) {
        controls.append(button(decision, async (event) => {
          const clicked = event.currentTarget;
          if (!rationale.value.trim()) { rationale.setCustomValidity(tr("A rationale is required.")); rationale.reportValidity(); return; }
          rationale.setCustomValidity("");
          const option = intervention.options?.find((entry) => entry.optionId === intervention.recommendedAction?.optionId);
          if (decision === "allow" && !(await dialogs.confirm("Confirm requested permission", jsonDetails("Exact requested scope", { intervention, grants: option?.grants }), "allow"))) return;
          if (taskId !== state.taskId || projectId !== state.projectId) return;
          clicked.disabled = true;
          try {
            await request(`${taskPath(taskId)}/decisions`, post({ interventionId: intervention.interventionId, decision, rationale: rationale.value.trim(), ...(decision === "allow" && option?.grants?.[0] ? { grants: option.grants[0] } : {}) }));
            await refresh(taskId);
          } finally { clicked.disabled = false; }
        }, decision === "deny" ? "" : "primary"));
      }
      item.append(controls); decisions.append(item);
    }
  }
  const evidence = document.getElementById("evidence"); evidence.replaceChildren();
  for (const record of detail?.evidence ?? []) {
    const raw = state.events.find((event) => event.type === "evidence.recorded" && event.payload?.evidenceId === record.evidenceId)?.payload;
    evidence.append(node("details", {}, [
      node("summary", { text: `${record.level} · ${record.producer} · ${tr(record.status)}` }),
      node("p", { text: record.summary }),
      jsonDetails("Observation and provenance", raw ?? record),
    ]));
  }
  if (!detail?.evidence?.length) evidence.append(note("No evidence recorded."));
  const checkpoints = document.getElementById("checkpoints"); checkpoints.replaceChildren();
  for (const branch of detail?.branches ?? []) checkpoints.append(jsonDetails(branch.label, branch));
  for (const checkpoint of state.checkpoints.slice(-8).reverse()) checkpoints.append(jsonDetails(tr(checkpoint.reason), checkpoint));
  if (!state.checkpoints.length) checkpoints.append(note("No checkpoints yet."));
  const cognition = document.getElementById("cognition");
  cognition.replaceChildren(jsonDetails("Learning and context", {
    learning: state.run?.learning ?? null,
    context: state.events.filter((entry) => entry.type === "context.plan_created").at(-1)?.payload ?? null,
    degradation: detail?.degradation ?? null,
  }));
}
