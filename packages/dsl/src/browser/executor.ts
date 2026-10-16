// @parcha/agentrun-dsl/browser/executor: the DSL's own executor for a code node, for a Web Worker the host has locked down.
// These are the very functions the Node entry runs (code-exec.ts), not a copy: `compileTransform` compiles a transform
// with `new Function` after shadowing `DENIED_GLOBALS`, and `deniedGlobalReferences` is the lint a host runs first.
//
// It is a denylist plus `new Function`. It is NOT a sandbox: it does not stop code from reaching a global it does not name,
// and it sets no deadline. The sandbox is the Worker around it, which the host owns: no network, a time limit, a fresh
// Worker for each run. ./browser and ./browser/worker never import this module, so their bundles hold no `new Function`;
// a host that wants code to run imports it from this subpath, inside that Worker, and passes it to `serveWorker` as `runCode`.
export { compileTransform, deniedGlobalReferences } from "../code-exec.js";
export { DENIED_GLOBALS } from "../denied-globals.js";
