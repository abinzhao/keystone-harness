import { button, jsonDetails, node, note, tr } from "../components/dom.js";
import { collection, emptyProjection, projectionDetails, servicePage, unwrap } from "../components/service.js";
import { post, projectPath } from "../client/api.js";

export function createCognitionView(host, { projectId, request, dialogs }) {
  if (!projectId) {
    host.replaceChildren(note("Select a project to inspect cognition."));
    return { dispose() {} };
  }
  const path = `${projectPath(projectId)}/cognition`;
  const page = servicePage(host, {
    title: "Project cognition", description: "Facts, rules and experience retain their sources. Only confirmed kernel events change what future tasks use.",
    path, request,
    render(body, state, resource) {
      const data = unwrap(state.data)?.cognition ?? unwrap(state.data);
      body.replaceChildren();
      if (!data) return;
      if (data.summary || data.index || data.indexStatus || data.coverage || data.scan) {
        body.append(jsonDetails("Index coverage and freshness", { summary: data.summary, index: data.index ?? data.indexStatus, coverage: data.coverage, scan: data.scan, updatedAt: data.updatedAt }));
      }
      const facts = collection(data, "facts", "projectFacts");
      const entries = collection(data, "experience", "experiences", "entries");
      const candidates = collection(data.experience, "candidates") ?? collection(data, "candidates");
      const experience = entries !== null || candidates !== null ? [...(entries ?? []), ...(candidates ?? [])] : null;
      body.append(node("h3", { text: tr("Facts and rules") }));
      for (const fact of facts ?? []) {
        const id = fact.factId ?? fact.id;
        const frozen = fact.frozen === true || fact.status === "frozen";
        const row = node("article", { class: "record-row" }, [
          node("h4", { text: fact.statement ?? fact.description ?? id ?? tr("Unknown") }),
          node("p", { class: "muted", text: [fact.status, frozen ? tr("Frozen") : "", fact.updatedAt].filter(Boolean).join(" · ") }),
          projectionDetails(fact),
        ]);
        const actions = node("div", { class: "row" });
        async function mutate(action, statement) {
          if (!id || typeof fact.hash !== "string" || !fact.hash) return;
          const patch = { expectedHash: fact.hash, ...(action === "correct" ? { statement } : { frozen: action === "freeze" }) };
          if (!(await dialogs.confirm("Confirm fact change", node("div", {}, [
            note("This records a user correction or freeze request. The service decides its effect on active context and evidence."),
            projectionDetails(fact), jsonDetails("Requested change", patch),
          ])))) return;
          if (resource.disposed || resource.state.busy || resource.state.stale) return;
          await resource.mutate(`${projectPath(projectId)}/facts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
        }
        const correct = button("Correct fact", async () => {
          const statement = await dialogs.prompt("Correct fact", "Fact statement", fact.statement ?? "");
          if (statement?.trim()) await mutate("correct", statement.trim());
        });
        const freeze = button(frozen ? "Unfreeze fact" : "Freeze fact", () => mutate(frozen ? "unfreeze" : "freeze"));
        correct.disabled = !id || !fact.hash || frozen || state.busy || state.loading || state.stale;
        freeze.disabled = !id || !fact.hash || state.busy || state.loading || state.stale;
        actions.append(correct, freeze); row.append(actions);
        if (!id) row.append(note("This record has no stable ID; changes are unavailable.", "warn"));
        else if (!fact.hash) row.append(note("The service did not provide a fact hash. Reload before changing this record.", "warn"));
        body.append(row);
      }
      if (facts === null || !facts.length) emptyProjection(body, null, facts, "No facts recorded for this project.");
      body.append(node("h3", { text: tr("Experience") }), note("Candidate experience is quarantined. User confirmation does not bypass the experience firewall."));
      for (const entry of experience ?? []) {
        const id = entry.entryId ?? entry.candidateId ?? entry.experienceId ?? entry.id;
        const row = node("article", { class: "record-row" }, [
          node("h4", { text: entry.statement ?? entry.summary ?? entry.description ?? id ?? tr("Unknown") }),
          node("p", { class: "muted", text: [entry.status, entry.updatedAt].filter(Boolean).join(" · ") }),
          projectionDetails(entry),
        ]);
        const actions = node("div", { class: "row" });
        for (const action of ["confirm", "revoke"]) {
          const eligible = action === "confirm"
            ? Boolean(entry.candidateId && entry.status === "quarantined" &&
              !["untrusted", "restricted"].includes(entry.provenance?.trustLevel ?? entry.provenance?.trust))
            : Boolean((entry.entryId && ["active", "frozen"].includes(entry.status)) ||
              (entry.candidateId && entry.status === "quarantined"));
          const control = button(action === "confirm" ? "Confirm experience" : "Revoke experience", async () => {
            if (!eligible) return;
            let reason;
            if (action === "revoke") {
              reason = await dialogs.prompt("Revoke experience", "Reason for revocation");
              if (!reason) return;
            }
            const patch = { action, ...(reason ? { reason } : {}) };
            if (!(await dialogs.confirm("Confirm experience change", node("div", {}, [projectionDetails(entry), jsonDetails("Requested change", patch)]), "Confirm", action === "revoke"))) return;
            if (resource.disposed || resource.state.busy || resource.state.stale) return;
            await resource.mutate(`${projectPath(projectId)}/experience/${encodeURIComponent(id)}`, post(patch));
          }, action === "revoke" ? "danger" : "");
          control.disabled = !id || !eligible || state.busy || state.loading || state.stale;
          actions.append(control);
        }
        row.append(actions); body.append(row);
      }
      if (experience === null || !experience.length) emptyProjection(body, null, experience, "No experience recorded for this project.");
      body.append(jsonDetails("Service response", state.data));
    },
  });
  const scan = button("Refresh cognition", async () => {
    if (page.resource.disposed || page.resource.state.busy) return;
    scan.disabled = true;
    try { await page.resource.mutate(path, post({})); }
    finally { if (!page.resource.disposed) scan.disabled = false; }
  });
  page.actions.append(scan); void page.load();
  return page;
}
