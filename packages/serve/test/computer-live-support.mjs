// Fakes for the run-side computer viewer (computer-live.ts): a computer's watch whose frames the test pushes and whose
// input it records, tl-places' computer-hold as the viewer drives it, and a desktop provider for the runner's own
// composition. No clock and no network: every wait is on a promise the fake settles.
import { deflateSync } from "node:zlib";

/** A provider's watch on one computer (provider.watch(ref, handlers, options), bound to its ref). `push(frame)` hands a
 *  frame to the viewer and resolves once the viewer's side acked it; `end(code, message)` ends the watch as a computer
 *  that went; `inputs` is every input() call's actions; `refuse` makes the next input fail in those words. */
export function fakeWatch({ start, hang = false, hangClose = false } = {}) {
  const state = { handlers: null, options: null, closed: 0, inputs: [], acks: 0, refuse: null, opened: 0 };
  /** While set, each input() waits for the test's release(): a computer slow to take input. */
  let gate = null;
  /** A watch that has not answered yet (`hang`): opened() resolves when asked, the watch once the test lets it. */
  let letStart;
  const started = hang ? new Promise((resolve) => (letStart = resolve)) : null;
  let opened;
  const openedNow = new Promise((resolve) => (opened = resolve));
  const inputWaiters = [];
  const watch = async (handlers, options) => {
    if (start) return start;
    state.handlers = handlers;
    state.options = options;
    state.opened += 1;
    opened();
    if (started) await started;
    return {
      ok: true,
      value: {
        async input(actions) {
          state.inputs.push(actions);
          for (const w of inputWaiters.splice(0)) w(actions);
          if (gate) await gate.promise;
          if (state.refuse) {
            const message = state.refuse;
            state.refuse = null;
            return { ok: false, error: { code: "refused", message } };
          }
          return { ok: true, value: { done: actions.length } };
        },
        async close() {
          state.closed += 1;
          // A computer that never answers the close (`hangClose`).
          if (hangClose) await new Promise(() => {});
        },
      },
    };
  };
  return {
    watch,
    state,
    opened: () => openedNow,
    /** Hands `frame` to the viewer; resolves once its own ack came (each frame's ack is its own: a second call of one
     *  ack counts again, so a test sees an ack called twice). */
    push(frame) {
      return new Promise((resolve) => {
        state.handlers.frame({ seq: 1, format: "jpeg", width: 1280, height: 800, frameWidth: 1280, frameHeight: 800, ...frame }, () => {
          state.acks += 1;
          resolve();
        });
      });
    },
    end(code, message) {
      state.handlers.ended({ code, message });
    },
    /** The next input() call's actions. */
    nextInput: () => new Promise((resolve) => inputWaiters.push(resolve)),
    /** Holds each input() until the returned release() is called. */
    blockInputs() {
      let release;
      gate = { promise: new Promise((resolve) => (release = resolve)) };
      return () => {
        gate = null;
        release();
      };
    },
    /** A `hang` watch answers now. */
    start: () => letStart?.(),
  };
}

/** tl-places' computer-hold for one run's computer, as the viewer drives it (computer-live.ts ViewerHold). `take` moves
 *  to pending (or, with `grant`, straight to person), `grant()` lets a pending take go live, `give` and `away` go back to
 *  the agent; each change is emitted to the listeners as the real one fires after its commit. `calls` is what was asked. */
export function fakeHold({ grant = false } = {}) {
  let state = "agent";
  /** What the run's own hold says this moment (ViewerHold.driving), when the test sets it apart from the committed state. */
  let driving;
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
    /** The listeners subscribed now. */
    listening: () => listeners.size,
    /** Sets what driving() answers apart from the committed state (undefined: as the committed state says). */
    drive(value) {
      driving = value;
    },
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
      driving: () => (driving === undefined ? state === "person" : driving),
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** A PNG of `w` x `h` pixels of one colour: a frame a browser draws, and a screenshot a model is given. */
export function solidPng(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A desktop provider in the computer module's shape, for the runner's own composition (main.ts runnerComputers' `load`):
 * it makes one desktop, whose watch (provider.watch(ref, handlers, options)) hands the viewer one PNG frame and records
 * every input. `record` holds what it was asked. With `holdShot: n`, the n-th screenshot waits inside the shot until
 * `letGo()` (`inShot` resolves once it is there), so an agent's look is in flight for as long as the test likes.
 */
export function fakeDesktopProvider({ holdShot } = {}) {
  const shotPng = solidPng(64, 40, [200, 200, 200]);
  const record = { created: [], released: [], watched: 0, acks: 0, inputs: [], closed: 0, shots: 0 };
  const inputWaiters = [];
  let inside;
  const inShot = new Promise((resolve) => (inside = resolve));
  let letGo;
  const goOn = new Promise((resolve) => (letGo = resolve));
  const client = {
    async call(method) {
      if (method === "screen.shot") {
        record.shots += 1;
        if (record.shots === holdShot) {
          inside();
          await goOn;
        }
        return { ok: true, value: { id: `shot-${record.shots}`, data: shotPng.toString("base64"), eof: true, size: shotPng.length, width: 64, height: 40 } };
      }
      if (method === "input.actions") return { ok: true, value: { done: 0 } };
      return { ok: false, error: { code: "unsupported", message: `the fake desktop has no ${method}` } };
    },
  };
  const provider = {
    id: "e2b",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(spec);
      return { ok: true, value: { id: "desk-1", name: "desk-1" } };
    },
    connect: async () => ({ ok: true, value: { client, hello: { version: "0", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"] }, close: async () => {} } }),
    attach: async () => ({ ok: true, value: { id: "desk-1", name: "desk-1", spec: { image: "desktop", user: "1000:1000", network: "open" } } }),
    async watch(_ref, handlers) {
      record.watched += 1;
      setImmediate(() => handlers.frame({ seq: 1, format: "png", bytes: solidPng(64, 40, [30, 120, 200]), width: 1280, height: 800, frameWidth: 64, frameHeight: 40 }, () => (record.acks += 1)));
      return {
        ok: true,
        value: {
          async input(actions) {
            record.inputs.push(actions);
            for (const waiter of inputWaiters.splice(0)) waiter(actions);
            return { ok: true, value: { done: actions.length } };
          },
          async close() {
            record.closed += 1;
          },
        },
      };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
  return {
    record,
    inShot,
    letGo: () => letGo(),
    /** The runner's provider loader (computerProviderMakers' load): this desktop, whatever provider id it is asked for. */
    load: async () => provider,
    /** The next input the watch is given. */
    nextInput: () => new Promise((resolve) => inputWaiters.push(resolve)),
  };
}
