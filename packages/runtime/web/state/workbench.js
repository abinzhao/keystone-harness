import { taskPath } from "../client/api.js";

const emptyTask = () => ({ detail: null, proof: null, run: null, events: [], checkpoints: [], lastSeq: 0 });

/** Presentation state only; a whole server bundle is committed after admission. */
export function createWorkbenchClient({ request }) {
  const state = { projectId: null, taskId: null, projects: [], tasks: [], ...emptyTask(), loading: false, connection: "connecting", error: "" };
  const listeners = new Set();
  let version = 0;
  let controller = null;
  let visible = true;
  let disposed = false;
  let polling = null;
  let listVersion = 0;
  let listController = null;
  let selectionVersion = 0;
  const emit = () => listeners.forEach((listener) => listener(state));
  const abort = () => { version += 1; controller?.abort(); controller = null; polling = null; };
  const optional = async (path, signal, fallback) => {
    try { return await request(path, { signal }); }
    catch (error) { if (error.status === 404) return fallback; throw error; }
  };

  async function load(clear) {
    if (disposed || !visible || state.taskId === null) return;
    abort();
    const selectedVersion = version;
    const taskId = state.taskId;
    controller = new AbortController();
    const signal = controller.signal;
    if (clear) Object.assign(state, emptyTask());
    state.loading = true;
    state.error = "";
    emit();
    try {
      const base = taskPath(taskId);
      const [detail, proof, events, checkpoints, run] = await Promise.all([
        request(base, { signal }),
        optional(`${base}/proof`, signal, null),
        request(`${base}/events?since=0`, { signal }),
        optional(`${base}/checkpoints`, signal, { checkpoints: [] }),
        optional(`${base}/run`, signal, null),
      ]);
      if (disposed || signal.aborted || selectedVersion !== version) return;
      if (detail.taskId !== taskId || (proof?.taskId && proof.taskId !== taskId) || (run?.taskId && run.taskId !== taskId)) {
        throw new Error("The task response belongs to another selection.");
      }
      Object.assign(state, {
        detail, proof, run, events: events.events ?? [], checkpoints: checkpoints.checkpoints ?? [],
        lastSeq: (events.events ?? []).reduce((max, event) => Math.max(max, event.seq), 0),
        loading: false, connection: "connected", error: "",
      });
      emit();
    } catch (error) {
      if (signal.aborted || disposed || selectedVersion !== version) return;
      Object.assign(state, { loading: false, connection: "stale", error: error.message ?? String(error) });
      emit();
    }
  }

  const client = {
    state,
    get selectionVersion() { return selectionVersion; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    selectTask(taskId) {
      selectionVersion += 1;
      abort();
      Object.assign(state, emptyTask(), { taskId, loading: false, error: "" });
      emit();
      if (taskId === null) return Promise.resolve();
      return load(false);
    },
    selectProject(projectId) {
      selectionVersion += 1;
      abort();
      Object.assign(state, emptyTask(), { projectId, taskId: null, loading: false, error: "" });
      emit();
    },
    async refreshLists() {
      const selectedVersion = ++listVersion;
      listController?.abort();
      listController = new AbortController();
      const signal = listController.signal;
      try {
        const [projects, tasks] = await Promise.all([request("/v1/projects", { signal }), request("/v1/tasks", { signal })]);
        if (disposed || signal.aborted || selectedVersion !== listVersion) return;
        Object.assign(state, { projects: projects.projects ?? [], tasks: tasks.tasks ?? [] });
        if (!state.taskId) state.connection = "connected";
        emit();
      } catch (error) {
        if (disposed || signal.aborted) return;
        Object.assign(state, { connection: "stale", error: error.message ?? String(error) });
        emit();
      }
    },
    poll() {
      if (polling || state.loading || !visible || disposed) return polling ?? Promise.resolve();
      const operation = load(false);
      polling = operation;
      void operation.finally(() => { if (polling === operation) polling = null; });
      return operation;
    },
    reconnect() { return load(false); },
    setVisible(value) {
      visible = value;
      if (!value) {
        abort(); listController?.abort();
        state.loading = false;
        state.connection = "stale";
        emit();
      }
    },
    dispose() { disposed = true; abort(); listController?.abort(); listeners.clear(); },
  };
  return client;
}
