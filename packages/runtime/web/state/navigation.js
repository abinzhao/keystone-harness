export function taskTitle(task) {
  const value = task.title || task.request || task.headline || task.contract?.goal || task.goal;
  return typeof value === "string" && value.trim() ? value.trim().split("\n")[0] : task.taskId;
}

export function groupProjectTasks(projects, tasks, search = "") {
  const query = search.trim().toLocaleLowerCase();
  const attention = new Set(["needs_attention", "awaiting_approval", "paused", "defining", "draft"]);
  const finished = new Set(["proven", "exited_gracefully", "failed", "stopped"]);
  return projects.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map((project) => {
    const matching = tasks.filter((task) => task.projectId === project.projectId && taskTitle(task).toLocaleLowerCase().includes(query))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const kindOf = (task) => attention.has(task.status) ? "attention" : finished.has(task.status) ? "finished" : "running";
    return { project, tasks: matching, sections: ["attention", "running", "finished"]
      .map((kind) => ({ kind, tasks: matching.filter((task) => kindOf(task) === kind) }))
      .filter((section) => section.tasks.length) };
  });
}
