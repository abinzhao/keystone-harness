import { button, node, tr } from "./dom.js";

const EXAMPLES = [
  ["Explain code", "Explain the project entry points and trace one main flow. Cite local files; do not change code."],
  ["Locate a problem", "Investigate the reported problem, identify supporting code and propose a minimal fix. Do not change code yet."],
  ["Plan a bug fix", "Plan a minimal bug fix with a regression test. Identify exact write paths before any implementation."],
  ["Design a scoped feature", "Design a small feature using the existing project patterns. Propose its scope and verification before writing code."],
];

export function createGettingStarted(host, { addProject, configureModel, openPlugin, example }) {
  const steps = node("div", { class: "setup-steps" });
  const state = node("p", { class: "setup-summary muted", role: "status" });
  const examples = node("div", { class: "example-drafts", "aria-label": tr("Example task drafts") },
    EXAMPLES.map(([label, text]) => button(label, () => example(tr(text)))));
  host.replaceChildren(steps, state, examples);
  return {
    update({ project, models = [] }) {
      steps.hidden = !!project && models.length > 0;
      steps.replaceChildren(
        node("div", { class: "setup-step" }, [
          node("span", { class: "setup-number", text: "1" }),
          node("div", {}, [node("strong", { text: tr(project ? "Local project ready" : "Add a local project") }),
            ...(project ? [node("p", { class: "muted", text: project.name || project.rootPath })] : [button("Add project", addProject)])]),
        ]),
        node("div", { class: "setup-step" }, [
          node("span", { class: "setup-number", text: "2" }),
          node("div", {}, [node("strong", { text: tr(models.length ? "Model route ready" : "Connect a model") }),
            ...(models.length ? [node("p", { class: "muted", text: models.map((entry) => entry.modelName || entry.id).join(", ") })]
              : [node("div", { class: "row" }, [button("Connect HTTP model", configureModel), button("TRAE CLI model", openPlugin)])])]),
        ]),
      );
      state.textContent = project && models.length ? `${project.name || project.rootPath} · ${models[0].modelName || models[0].id} · ${tr("Ready for a read-only task")}`
        : tr("Connect a project and model, then describe a task. Examples only fill a local draft.");
    },
  };
}
