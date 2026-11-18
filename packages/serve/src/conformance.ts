// The harness conformance suite, as a harness's author runs it on their own adapter (`@parcha/agentrun-serve/conformance`,
// HARNESS.md "Prove it"): the suite itself, the kernel's adapter loop a subject's loops are, and the types a subject is
// written in. The same suite proves every built-in harness in this repository's tests.
export { MAX_RESTARTS, registerHarnessConformance, type TestFunction } from "./runner/conformance/harness.js";
export type { ConformanceCase, ConformanceSetup, ConformanceSubject, KernelHooks, MetaToolName, ScriptStep, SuiteTool, ToolCall, ToolName } from "./runner/conformance/subject.js";
export { type AdapterLoopOptions, type AdapterRunSpec, createAdapterLoop } from "./runner/adapter-loop.js";
export { suiteHostTools } from "./runner/conformance/host-tools.js";
