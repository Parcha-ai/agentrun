// A run whose process is killed with SIGKILL right after the learn tool committed its candidate, before the tool result
// is committed. argv: <store path>.
import { agentLearn } from "../../dist/index.js";
import { ask, learnCalls, openRun } from "../support.mjs";

const LESSON = { type: "lesson", text: "Registries list officers under Principals, not Officers." };
const extension = agentLearn();
const [tool] = extension.tools;
const execute = tool.execute;
const killing = { ...extension, tools: [{ ...tool, execute: async (args, api, context) => {
  const result = await execute.call(tool, args, api, context);
  process.stdout.write(`executed ${api.callId} ${result.output[0].text}\n`);
  process.kill(process.pid, "SIGKILL");
  return result;
} }] };
const run = await openRun(process.argv[2], { extension: killing, steps: [() => learnCalls([LESSON])] });
await ask(run.harness);
process.stdout.write("not killed\n");
