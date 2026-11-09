// The walks' model (agentrun-serve's --faux module): no key, no network. A run whose first message reads
// "walk: <N> steps of <MS> ms" is N steps, each a `write` of step-<k>.txt that the model takes MS ms to ask for, then its
// answer. It reads where the run is from the conversation alone (the tool results so far), so a run taken over by
// another runner asks for the step it had not finished, never one it had. A stopped turn answers at once, as aborted.
// Each ask is one line on the runner's stderr, `walk-model: <runner> asks step <k> of <N>`, for the walk's log.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const asked = /walk: (\d+) steps of (\d+) ms/.exec(first);
  if (!asked) return faux.message("This model answers only a walk's run.");
  const [steps, ms] = [Number(asked[1]), Number(asked[2])];
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  if (done >= steps) return faux.message(`Walk done: ${steps} steps.`);
  const step = done + 1;
  console.error(`walk-model: ${process.env.AGENTRUN_RUNNER_NAME ?? "server"} asks step ${step} of ${steps}`);
  const call = faux.message(faux.toolCall("write", { path: `step-${step}.txt`, content: `step ${step}\n` }), { stopReason: "toolUse" });
  if (ms <= 0) return call;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(call), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });
}
