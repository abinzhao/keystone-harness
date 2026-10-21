import { button, field, jsonDetails, node, note, tr } from "../components/dom.js";
import { collection, downloadJson, emptyProjection, projectionDetails, servicePage, unavailable, unwrap } from "../components/service.js";
import { post } from "../client/api.js";

export function createLabView(host, { request, dialogs }) {
  let reviewing = false;
  let inputVersion = 0;
  const reviewStatus = node("div", { role: "status", "aria-live": "polite" });
  const directory = field("Extension directory to check", "lab-directory");
  const run = button("Run isolated checks", async () => {
    const path = directory.input.value.trim();
    if (!path || reviewing || page.resource.state.busy || page.resource.disposed) { directory.input.focus(); return; }
    const selected = inputVersion;
    const current = () => !page.resource.disposed && selected === inputVersion && path === directory.input.value.trim();
    reviewing = true; run.disabled = true;
    reviewStatus.replaceChildren(note("Reviewing manifest, integrity and requested permissions"));
    try {
      const response = await request("/v1/extensions/review", post({ directory: path }));
      if (!current()) return;
      const review = unwrap(response)?.review ?? unwrap(response);
      reviewStatus.replaceChildren(projectionDetails(review));
      if (!review?.reviewHash || review.blockers?.length || review.staticChecksPassed === false || review.supported === false || review.available === false || review.error) {
        reviewStatus.append(note("Static review has blocking failures or no usable hash. Lab execution is unavailable.", "warn")); return;
      }
      const input = { directory: path, reviewHash: review.reviewHash, confirmed: true };
      if (!(await dialogs.confirm("Run isolated checks", node("div", {}, [
        note("Checks may execute extension code. The service must use a separate data root and temporary project; this is not production-provider or release evidence."),
        projectionDetails(review), jsonDetails("Lab target", input),
      ]), "Run isolated checks"))) return;
      if (!current() || page.resource.state.busy) return;
      await page.resource.mutate("/v1/lab", post(input));
    } catch (error) { if (current()) reviewStatus.replaceChildren(unavailable(error)); }
    finally { reviewing = false; if (!page.resource.disposed) run.disabled = false; }
  }, "primary");
  directory.input.addEventListener("input", () => { inputVersion += 1; reviewStatus.replaceChildren(); });
  const page = servicePage(host, {
    title: "Harness Lab", description: "Inspect local conformance reports and run explicitly selected extensions in isolation.",
    path: "/v1/lab", request,
    render(body, state) {
      body.replaceChildren();
      const data = unwrap(state.data);
      if (!data) return;
      const reports = collection(data, "reports", "runs", "entries");
      for (const report of reports ?? []) {
        body.append(node("article", { class: "record-row" }, [
          node("h3", { text: report.name ?? report.reportId ?? report.id ?? tr("Lab report") }),
          node("p", { class: "muted", text: [report.status, report.createdAt ?? report.generatedAt, report.directory].filter(Boolean).join(" · ") }),
          projectionDetails(report),
          button("Export report", () => downloadJson("keystone-lab-report.json", report)),
        ]));
      }
      if (reports === null || !reports.length) emptyProjection(body, null, reports, "No Lab reports recorded.");
      if (state.result) body.append(jsonDetails("Lab run result", state.result));
      body.append(jsonDetails("Service response", state.data));
    },
  });
  page.controls.append(node("div", { class: "form-grid lab-target" }, [directory.wrap, run, reviewStatus]));
  void page.load(); return page;
}
