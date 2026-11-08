// The harness conformance suite's WORKFLOW subject: a workflow revision's run on the runner (runner/workflow-loop.ts), the
// DSL durable engine unchanged. A workflow's calls are the engine's effect records (agentrun.effects), not the kernel's
// call records, so the subject reads them its own way (readCalls). Its unsupported cases come from two declared facts:
//   intentBeforeDispatch: false — the engine admits an effect's intent BEFORE it dispatches the call and reconciles a
//     crashed one as interrupted, so there is no point before the intent for the suite's crash/fault cases to land;
//   personWait: "raise" — a workflow has no person turn (steer, approval, ask) nor a trigger message; its only person-wait
//     is the spend-cap raise, proven in runner-workflow-loop.test.mjs.
// What it proves here: stop ends the run stopped, and (the engine's own durability) a crashed workflow resumes, which that
// loop test covers end to end. The crash/fault/person cases are skipped with the fact's reason, never passed.
import { createModels } from "@earendil-works/pi-ai/models";
import { workspaceFiles, withRecovery } from "@parcha/agentrun-dsl/recovery";

const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { createWorkflowExtension } = await import("@parcha/agentrun-pi/durable");

/** The suite's script as a workflow: one call node per `{ call }` step (a chain when there is more than one), the suite's
 *  tool as the call's effect. `{ say }` steps are the model's, which a workflow has none of, so they are left out. */
function workflowOfScript(script) {
  const calls = script.filter((step) => "call" in step);
  const steps = calls.map((step, index) => ({ node: "call", label: `${step.call}-${index}`, via: "tool", tool: step.call, args: {}, out: "Any", as: `out${index}` }));
  return {
    v: 2, name: "conformance",
    schemas: { In: { type: "object", additionalProperties: true }, Any: {} },
    input: { schemaId: "In" },
    output: { schemaId: "Any", path: `out${Math.max(0, calls.length - 1)}` },
    root: steps.length === 1 ? steps[0] : { node: "chain", steps },
  };
}

/** A call node's effect that runs the suite's tool through the kernel's two points (the suite's hooks), replay-safe as the
 *  tool is. The DSL driver admits the effect and dispatches this; the hooks fire around the tool, as they do for a pi call. */
function runEffectOf(setup) {
  let seq = 0;
  return async ({ node, input, signal }) => {
    const tool = setup.tools[node.tool];
    if (!tool) throw new Error(`the conformance workflow calls no suite tool ${node.tool}`);
    const call = { callId: `${node.tool}:${seq++}`, tool: node.tool, args: input ?? {} };
    await setup.hooks.beforeIntent(call);
    const output = await tool.run(call.args, signal);
    await setup.hooks.beforeResult(call, output);
    return output;
  };
}

/** The run's calls from the DSL engine's effect records (agentrun.effects): one per effect, completed as done (a tool
 *  failure as failed) and an admitted-but-unfinished one as interrupted. The kernel's callsOf passes these over. */
async function readCalls(journal, context) {
  const calls = [];
  for (let cursor; ; ) {
    const page = await journal.scanDocuments({ kind: "agentrun.effects", scope: { kind: "session" } }, 500, cursor, context);
    for (const record of page.items) {
      const value = (await journal.document(record.id, "current", context))?.value ?? {};
      const result = value.result;
      const failed = result && typeof result === "object" && ("agentrun_serve_tool_failed" in result);
      const status = value.status === "completed" ? (failed ? "failed" : "done") : "interrupted";
      calls.push({ callId: String(record.key ?? record.id), tool: String(value.name ?? ""), status, startEntry: 0 });
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return calls;
}

/** The workflow conformance subject. */
export function workflowSubject() {
  const crash = "the DSL engine admits an effect's intent before it dispatches the call (intentBeforeDispatch: false) and reconciles a crashed one as interrupted, so the suite's crash and fault cases have no point to land before the intent; the engine's own durability is proven by runner-workflow-loop.test.mjs";
  const person = "a workflow has no person turn; its only person-wait is the spend-cap raise (personWait: raise), proven in runner-workflow-loop.test.mjs";
  return {
    name: "workflow",
    createLoop(setup) {
      const workflow = workflowOfScript(setup.script);
      const runEffect = runEffectOf(setup);
      const tools = [...new Set(setup.script.flatMap((step) => ("call" in step ? [step.call] : [])))];
      const specOf = async () => ({
        models: createModels(), workflow, input: {}, tools, agentId: "agent-1", revisionId: "rev-1",
        build: () => ({
          extensions: [],
          host: {
            options: () => ({ files: workspaceFiles("/tmp"), afterAdmit: async () => {} }),
            run: ({ driver }) => ({ deps: withRecovery(driver, { runEffect }, { durableNodes: true }) }),
          },
        }),
      });
      return createWorkflowLoop(specOf);
    },
    unsupported: {
      "crash-before-intent": crash, "crash-after-intent": crash, "crash-before-intent-process": crash, "crash-after-intent-process": crash,
      "stalled-past-lease-process": "the workflow subject runs in-process; it names no runner-process module",
      "fault-effects-once": crash, "fault-restarts-bounded": crash, "replay-safe-rerun": crash,
      "steer-mid-turn": person, "steer-origin": person, "deny-note": person, "park-on-ask": person, "cancel-parked": person,
      "approval-names-its-call": person, "approval-double-click": person, "message-never-answers": person,
    },
    readCalls,
  };
}
