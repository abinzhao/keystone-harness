/** A disposable server projection. Mutations are never applied optimistically. */
export function createResource({ path, request, onChange = () => {} }) {
  const state = { data: null, result: null, loading: false, busy: false, stale: false, error: null };
  let version = 0;
  let controller = null;
  let disposed = false;
  const emit = () => { if (!disposed) onChange(state); };
  const admit = (value) => {
    if (value?.supported === false || value?.available === false || value?.error) {
      throw Object.assign(new Error(value.reason ?? value.error ?? "Capability unavailable."), { status: 501, body: value });
    }
    return value;
  };
  async function load() {
    if (disposed) return;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const selected = ++version;
    state.loading = true; state.error = null; emit();
    try {
      const data = admit(await request(path, { signal }));
      if (disposed || signal.aborted || selected !== version) return;
      Object.assign(state, { data, stale: false });
    } catch (error) {
      if (disposed || signal.aborted || selected !== version) return;
      Object.assign(state, { error, stale: state.data !== null });
    } finally {
      if (!disposed && selected === version) { state.loading = false; emit(); }
    }
  }
  return {
    state, load,
    get disposed() { return disposed; },
    async mutate(target, init) {
      if (disposed || state.busy) return null;
      state.busy = true; state.error = null; state.result = null; emit();
      try {
        const result = admit(await request(target, init));
        if (disposed) return null;
        state.result = result;
        await load();
        return result;
      } catch (error) {
        if (!disposed) { state.error = error; state.stale = state.data !== null; }
        return null;
      } finally { state.busy = false; emit(); }
    },
    dispose() { disposed = true; version += 1; controller?.abort(); },
  };
}
