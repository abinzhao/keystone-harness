export function taskTitle(task) {
  const value = task.title || task.request || task.headline || task.contract?.goal || task.goal;
  return typeof value === "string" && value.trim() ? value.trim().split("\n")[0] : task.taskId;
}

export function groupProjectTasks(projects, tasks, search = "") {
  const query = search.trim().toLocaleLowerCase();
  return projects.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map((project) => ({
    project,
    tasks: tasks.filter((task) => task.projectId === project.projectId && taskTitle(task).toLocaleLowerCase().includes(query)),
  }));
}
