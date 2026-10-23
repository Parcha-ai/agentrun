// Runs the workflow revision in the run RUN describes (JSON) in this process, and holds its first tool call open until
// stdin ends: it prints "in-call" once the call is in flight, and the run's carry as JSON once the run ended.
import { runWorkflowRevision } from "../../dist/workflow.js";
import { ctx, hostFor, TOOLS } from "../workflow-support.mjs";

const run = JSON.parse(process.env.RUN);
const released = new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });
const host = await hostFor(run, {
  onCall: async (tool) => {
    if (tool !== "stock.check") return;
    process.stdout.write("in-call\n");
    await released;
  },
});
const { carry } = await runWorkflowRevision({ harness: host.harness, workflows: host.workflows, context: ctx, run, input: { sku: "sku-1", amount: 10 }, tools: TOOLS });
await host.close();
process.stdout.write(`${JSON.stringify(carry)}\n`);
