// The harness conformance suite's pi subject: pi-durable's own Harness on the run's journal (runner/loop.ts,
// createPiLoop), with pi-ai's faux model playing the suite's script. Each model turn answers the script step the
// conversation has reached: the step's index is the number of answers the model has given so far, read from the context
// pi sends, so a resumed run (a new process, a new faux provider) picks up at the step it was on.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const { createPiLoop } = await import("../dist/runner/loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""));

/** A faux provider whose answer to a request is script step N, N the model's answers in the request's context. */
export function scriptedModel(script) {
  const faux = fauxProvider();
  const answer = (context) => {
    const step = context.messages.filter((message) => message.role === "assistant").length;
    const next = script[step];
    if (next === undefined) return fauxAssistantMessage([fauxText("")], { stopReason: "stop" });
    if ("call" in next) return fauxAssistantMessage([fauxToolCall(next.call, next.args ?? {})], { stopReason: "toolUse" });
    // A said step ends the model's turn (in the suite's scripts it is always the last); sayLastSteer says the newest person
    // message, which is the steer once one was placed.
    const text = "say" in next ? next.say : textOf([...context.messages].reverse().find((message) => message.role === "user"));
    // A cut step: the model stops at its output limit as it says it.
    return fauxAssistantMessage([fauxText(text)], { stopReason: next.cut ? "length" : "stop" });
  };
  faux.setResponses(Array.from({ length: 64 }, () => answer));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}

/** The pi loop for the suite's setup: its tools as pi tools, its hooks at the kernel's two points, its gate asking for
 *  the tools that ask. */
export function piSpec({ script, tools, hooks }) {
  return () => {
    const { models, model } = scriptedModel(script);
    return {
      models,
      model,
      input: "Follow the script.",
      tools: Object.values(tools).map((tool) => ({
        name: tool.name,
        description: `The suite's ${tool.name} tool.`,
        parameters: { type: "object", properties: {} },
        replaySafe: tool.replaySafe,
        run: async (args, signal) => String(await tool.run(args, signal)),
      })),
      hooks,
      gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
      restartLimit: MAX_RESTARTS,
    };
  };
}

/** The subject the suite runs: pi loops for `setup`. */
export const piSubject = {
  name: "pi",
  // pi ends a turn at a length stop (its generation answers with it), so no step of the same turn follows a cut answer:
  // a run goes on from one only on a later message, and the run's end still reads its last answer (runner/loop.ts cutLast).
  unsupported: { "length-mid-run": "a cut answer ends pi's turn, so no later step of the same turn can follow it" },
  process: { module: import.meta.url, export: "piSubject" },
  createLoop: (setup) => createPiLoop(piSpec(setup)),
};
