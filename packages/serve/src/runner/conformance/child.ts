// The conformance suite's runner process (harness.ts, the process cases): a runner of its own on the suite's data
// directory, running the subject's loop for one call, that SIGKILLs itself at the kernel point it is given, so only what
// it had committed survives. Its argument: { dataDir, module, export, tool, point, countFile } as JSON.
import { openSqliteStore } from "../../store/index.js";
import { startRunner } from "../runner.js";
import { CONFORMANCE_TIMING, suiteTools } from "./harness.js";
import type { ConformanceSubject, KernelHooks, ToolName } from "./subject.js";

const config = JSON.parse(process.argv[2] ?? "{}") as { dataDir: string; module: string; export: string; tool: ToolName; point: keyof KernelHooks; countFile: string };
const subject = (await import(config.module))[config.export] as ConformanceSubject;
const { tools } = suiteTools(config.countFile);
const die = async () => {
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
};
const hooks: KernelHooks = {
  beforeIntent: async () => (config.point === "beforeIntent" ? die() : undefined),
  beforeResult: async () => (config.point === "beforeResult" ? die() : undefined),
};
const store = await openSqliteStore({ dataDir: config.dataDir, role: "runner" });
startRunner({ store, createLoop: subject.createLoop({ script: [{ call: config.tool }, { say: "done" }], tools, hooks }), name: "runner-process", ...CONFORMANCE_TIMING });
