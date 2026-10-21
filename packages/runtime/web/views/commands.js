import { button, field, jsonDetails, node, note, tr } from "../components/dom.js";
import { post, projectPath, taskPath } from "../client/api.js";
import { renderCommands } from "./task.js";

export function createCommandsView(host, { state, request, dialogs, refresh }) {
  const command = field("Executable", "command-executable", "node");
  const args = field("Arguments (JSON array)", "command-args", '["--version"]');
  const cwd = field("Working directory", "command-cwd", ".");
  const scope = field("Permitted write paths (one per line)", "command-scope", "", "textarea");
  const result = node("div", { role: "status", "aria-live": "polite" });
  const history = node("div");
  let disposed = false;
  let busy = false;
  const execute = button("Run command", async (event) => {
    const clicked = event.currentTarget;
    let parsed;
    try { parsed = JSON.parse(args.input.value); if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error(); }
    catch { result.replaceChildren(note("Arguments must be a JSON array of strings.", "bad")); return; }
    const input = {
      command: command.input.value.trim(), args: parsed, cwd: cwd.input.value.trim(),
      writePaths: scope.input.value.split("\n").map((value) => value.trim()).filter(Boolean), confirmed: true,
    };
    if (!state.projectId) return;
    if (!(await dialogs.confirm("Confirm command execution", node("div", {}, [
      note("Commands run without a shell. Application guards observe repository changes; they do not provide OS filesystem or network isolation."),
      jsonDetails("Exact command scope", input),
    ]), "Run command"))) return;
    const projectId = state.projectId;
    busy = true; clicked.disabled = true;
    result.replaceChildren(note("Command running"));
    try {
      const receipt = await request(`${projectPath(projectId)}/commands`, post(input));
      if (disposed) return;
      result.replaceChildren(note(receipt.scopeViolated ? "Command changed files outside its scope." : "Command recorded; verification is separate.", receipt.scopeViolated ? "bad" : ""),
        node("pre", { text: `${receipt.stdout ?? ""}\n${receipt.stderr ?? ""}` }), jsonDetails("Command, environment and lease", receipt));
      await refresh();
    } catch (error) { if (!disposed) result.replaceChildren(note(error.message, "bad")); }
    finally { busy = false; if (!disposed) clicked.disabled = !state.projectId; }
  }, "primary");
  host.replaceChildren(node("h2", { text: tr("Commands") }), node("div", { class: "form-grid" }, [
    command.wrap, args.wrap, cwd.wrap, scope.wrap, execute, result,
  ]), history);
  const update = () => {
    execute.disabled = busy || !state.projectId;
    renderCommands(history, state);
    for (const artifactId of [...new Set(state.events.filter((entry) => entry.type === "action.executed")
      .map((entry) => entry.payload.artifactId).filter(Boolean))]) {
      const output = node("pre");
      history.append(button("Load recorded output", async () => {
        const receipt = await request(`${taskPath(state.taskId)}/artifacts/${artifactId}`);
        if (!disposed) output.textContent = receipt.content;
      }), output);
    }
  };
  update();
  return { update, dispose() { disposed = true; } };
}
