// pi-ai's faux model playing a script, for the door's side of the live view's parity checks (live-support.mjs's
// doorStream, record-door-one-input.mjs): the stream serve reads today, from a Harness the test runs itself. B's runs
// play the same script through the pi adapter (conformance-pi-adapter.mjs). Each model turn answers the script step the
// conversation has reached: the step's index is the number of answers the model has given so far, read from the context
// pi sends.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""));

/** A faux provider whose answer to a request is script step N, N the model's answers in the request's context. */
export function scriptedModel(script) {
  const faux = fauxProvider();
  const answer = (context) => {
    const step = context.messages.filter((message) => message.role === "assistant").length;
    const next = script[step];
    if (next === undefined) return fauxAssistantMessage([fauxText("")], { stopReason: "stop" });
    if ("call" in next) return fauxAssistantMessage([fauxToolCall(next.call, next.args ?? {})], { stopReason: "toolUse" });
    // A said step ends the model's turn; sayLastSteer says the newest person message (the steer once one was placed).
    const text = "say" in next ? next.say : textOf([...context.messages].reverse().find((message) => message.role === "user"));
    return fauxAssistantMessage([fauxText(text)], { stopReason: "stop" });
  };
  faux.setResponses(Array.from({ length: 64 }, () => answer));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}
