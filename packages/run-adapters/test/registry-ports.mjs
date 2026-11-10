// Fakes of the registry's narrow computer ports (kernel/registry hands.ts: screen, input, phone, browser), for the
// kernel registry's tests: each records every call, in order, as [method, ...args], and answers what a test scripts.
// A refusal throws as the port says: an error with the computer's `code` and words.

/** A one-pixel PNG's bytes: what a fake shot answers unless a test gives others. */
export const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

export const refusal = (code, message) => Object.assign(new Error(message), { code });

/** A desktop's screen: shot answers `shot` (a PNG of width x height), or throws `refuse`. */
export function fakeScreen({ width = 1280, height = 800, png = PNG, refuse } = {}) {
  const calls = [];
  return {
    calls,
    async shot(options) {
      calls.push(["shot", options]);
      if (refuse) throw refuse;
      return { png, width, height };
    },
  };
}

/** A desktop's input: actions records each batch, or throws `refuse`. */
export function fakeInput({ refuse } = {}) {
  const calls = [];
  return {
    calls,
    async actions(list) {
      calls.push(["actions", list]);
      if (refuse) throw refuse;
    },
  };
}

/** A phone screen's structure, flattened, as the phone port gives it: a field, a button, a label (neither), a switch. */
export const PHONE_TREE = Object.freeze({
  nodes: [
    { role: "android.widget.EditText", id: "com.example.mail:id/to", text: "", label: "To", bounds: { x: 40, y: 300, w: 1000, h: 120 }, clickable: true, editable: true, focused: true },
    { role: "android.widget.Button", id: "com.example.mail:id/send", text: "Send", bounds: { x: 820, y: 2200, w: 220, h: 120 }, clickable: true, editable: false },
    { role: "android.widget.TextView", text: "New message", bounds: { x: 40, y: 120, w: 600, h: 80 }, clickable: false, editable: false },
    { role: "android.widget.Switch", label: "Attach signature", bounds: { x: 900, y: 600, w: 140, h: 80 }, clickable: true, editable: false },
  ],
  total: 37,
  truncated: false,
});

/** A phone: its screen, touch, typing, keys, apps and its screen's structure. */
export function fakePhone({ width = 1080, height = 2400, apps = [{ id: "com.example.mail", name: "Mail" }, { id: "com.example.maps" }], foreground = "com.example.mail", tree = PHONE_TREE, refuse } = {}) {
  const calls = [];
  const record = (...call) => {
    calls.push(call);
    if (refuse) throw refuse;
  };
  return {
    calls,
    async shot() {
      record("shot");
      return { png: PNG, width, height };
    },
    async tap(at) { record("tap", at); },
    async swipe(spec) { record("swipe", spec); },
    async type(text) { record("type", text); },
    async key(name) { record("key", name); },
    async tree() {
      record("tree");
      return tree;
    },
    apps: {
      async list() {
        record("apps.list");
        return { apps, foreground };
      },
      async open(id) { record("apps.open", id); },
    },
  };
}

/** A browser: connect answers a fake CDP session that records what is sent. */
export function fakeBrowser() {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push(["connect"]);
      return {
        async send(method, params) {
          calls.push(["send", method, params]);
          return {};
        },
        on: () => () => {},
        close: () => void calls.push(["close"]),
      };
    },
  };
}

/** A computer's hand-over to the person: ask records each request and answers `outcome` once `answer()` is called (at
 *  once with `now: true`); an abort of the call's signal rejects it. */
export function fakeHandoff({ outcome = "done", now = true } = {}) {
  const calls = [];
  let release;
  const answered = new Promise((resolve) => (release = resolve));
  if (now) release();
  return {
    calls,
    answer: () => release(),
    async ask(request, signal) {
      calls.push(["ask", request]);
      await Promise.race([answered, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      return { outcome };
    },
  };
}
