/** The globals a code transform may not name: shadowed when this process compiles a transform, and named by the
 *  lint that a host running code from an untrusted author applies first. */
export const DENIED_GLOBALS = [
  "require", "module", "exports", "process", "global", "globalThis", "__dirname", "__filename",
  "fetch", "XMLHttpRequest", "Function", "Buffer",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Promise", "Date",
];
