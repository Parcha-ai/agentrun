// Fakes for the run-side computer viewer (computer-live.ts): a computer's watch whose frames the test pushes and whose
// input it records, and tl-places' computer-hold as the viewer drives it. No clock and no network: every wait is on a
// promise the fake settles.

/** A provider's watch on one computer (provider.watch(ref, handlers, options), bound to its ref). `push(frame)` hands a
 *  frame to the viewer and resolves once the viewer's side acked it; `end(code, message)` ends the watch as a computer
 *  that went; `inputs` is every input() call's actions; `refuse` makes the next input fail in those words. */
export function fakeWatch({ start } = {}) {
  const state = { handlers: null, options: null, closed: 0, inputs: [], acks: 0, refuse: null, opened: 0 };
  let acked = null;
  let opened;
  const openedNow = new Promise((resolve) => (opened = resolve));
  const inputWaiters = [];
  const watch = async (handlers, options) => {
    if (start) return start;
    state.handlers = handlers;
    state.options = options;
    state.opened += 1;
    opened();
    return {
      ok: true,
      value: {
        async input(actions) {
          state.inputs.push(actions);
          for (const w of inputWaiters.splice(0)) w(actions);
          if (state.refuse) {
            const message = state.refuse;
            state.refuse = null;
            return { ok: false, error: { code: "refused", message } };
          }
          return { ok: true, value: { done: actions.length } };
        },
        async close() {
          state.closed += 1;
        },
      },
    };
  };
  return {
    watch,
    state,
    opened: () => openedNow,
    /** Hands `frame` to the viewer; resolves once its ack came. */
    push(frame) {
      return new Promise((resolve) => {
        acked = () => {
          state.acks += 1;
          resolve();
        };
        state.handlers.frame({ seq: 1, format: "jpeg", width: 1280, height: 800, frameWidth: 1280, frameHeight: 800, ...frame }, () => acked?.());
      });
    },
    end(code, message) {
      state.handlers.ended({ code, message });
    },
    /** The next input() call's actions. */
    nextInput: () => new Promise((resolve) => inputWaiters.push(resolve)),
  };
}

/** tl-places' computer-hold for one run's computer, as the viewer drives it (computer-live.ts ViewerHold). `take` moves
 *  to pending (or, with `grant`, straight to person), `grant()` lets a pending take go live, `give` and `away` go back to
 *  the agent; each change is emitted to the listeners as the real one fires after its commit. `calls` is what was asked. */
export function fakeHold({ grant = false } = {}) {
  let state = "agent";
  const listeners = new Set();
  const calls = [];
  const waiters = [];
  const emit = (event) => {
    state = event.state;
    for (const listener of listeners) listener(event);
  };
  const called = (name) => {
    calls.push(name);
    for (const w of waiters.splice(0)) w(name);
  };
  return {
    calls,
    emit,
    /** The next call made of the hold. */
    nextCall: () => new Promise((resolve) => waiters.push(resolve)),
    grant: () => emit({ state: "person" }),
    hold: {
      state: () => state,
      async take() {
        called("take");
        emit({ state: grant ? "person" : "pending" });
        return { hold: state };
      },
      async give() {
        called("give");
        if (state !== "agent") emit({ state: "agent", ended: "given" });
        return { hold: state };
      },
      async away() {
        called("away");
        if (state !== "agent") emit({ state: "agent", ended: "away" });
      },
      touched() {
        calls.push("touched");
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}
