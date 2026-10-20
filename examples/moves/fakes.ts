// The offline model: a pi-ai faux provider whose answer is a pure function of the transcript, so it is the same across a kill,
// a resume and three generations. It plays the root in the three stages the app's prompts open with, and a thread in the one
// stage a fork starts. Every answer carries a thinking block, as the live model's do (thinking is on).
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { MODEL } from "./config.ts";

type Block = { type?: string; text?: string };
const textOf = (message: unknown): string => {
  const m = message as { content?: unknown; output?: unknown };
  const blocks = m?.output ?? m?.content;
  return typeof blocks === "string" ? blocks : Array.isArray(blocks) ? (blocks as Block[]).map((b) => b.text ?? "").join("") : "";
};

/** The brief the root writes, and the job a thread writes: small, and a real number out. */
export const BRIEF = "Train a tiny regression on the GPU for a few seconds. Threads choose the learning rate and the width; lower final loss is better.\n";
export const jobFor = (n: number) => {
  const lr = 0.002 * n;
  const width = 8 * n;
  const loss = Math.abs(lr - 0.008) * 50 + 1 / width + n * 0.001; // thread 4 wins: lr 0.008
  return { settings: { lr, width }, loss: Number(loss.toFixed(5)) };
};

/** What the transcript after the last user message holds: the tool results so far, by tool name, in order. */
function sinceLastUser(messages: Message[]): { user: string; results: { tool: string; text: string }[] } {
  const at = messages.findLastIndex((m) => m.role === "user");
  const after = messages.slice(at + 1);
  return {
    user: at < 0 ? "" : textOf(messages[at]),
    results: after.filter((m) => (m.role as string) === "toolResult").map((m) => ({ tool: String((m as unknown as { toolName?: string }).toolName ?? ""), text: textOf(m) })),
  };
}

const think = (what: string) => fauxThinking(`${what}`);
const call = (name: string, args: Record<string, string | number>, id: string) => fauxAssistantMessage([think(`I will call ${name}.`), fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage([think("I have what I need."), fauxText(text)]);

export function brain(context: { messages: Message[] }) {
  const messages = context.messages.filter((m) => (m.role as string) !== "system");
  const { user, results } = sinceLastUser(messages);
  const thread = /^Thread (\d+) of (\d+)\./.exec(user);
  if (thread) {
    const n = Number(thread[1]);
    const { settings, loss } = jobFor(n);
    // The job also reports which key-looking variables its process can see (none: a sandbox holds no secret) and the GPU it has.
    const job = `console.log("final_loss=" + ${loss});\nconsole.log("gpu=stand-in for nvidia-smi");\nconsole.log("secretish_env=" + JSON.stringify(Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k))));\n`;
    if (results.length === 0) return call("gpu_write", { path: "job.mjs", content: job }, `t${n}-write`);
    if (results.length === 1) return call("gpu_bash", { command: `${process.execPath} job.mjs` }, `t${n}-run`);
    const metric = /final_loss=([0-9.]+)/.exec(results[1]!.text)?.[1] ?? "nan";
    const gpu = /gpu=(.*)/.exec(results[1]!.text)?.[1] ?? "unknown";
    const env = /secretish_env=(.*)/.exec(results[1]!.text)?.[1] ?? "?";
    return say(`METRIC=${metric} SETTINGS=${JSON.stringify(settings)} GPU=${gpu} (key-like variables seen: ${env})`);
  }
  const stage = /^\[stage (\d)\]/.exec(user)?.[1];
  if (stage === "1") {
    if (results.length === 0) return call("write_note", { path: "brief.md", content: BRIEF }, "s1-brief");
    if (results.length === 1) return call("move_to", { to: "modal" }, "s1-move");
    return say("The brief is written. Moving to the Modal VM.");
  }
  if (stage === "2") {
    if (results.length === 0) return call("fork_threads", { job: "Train a tiny regression and report its final loss." }, "s2-fork");
    if (results.length === 1) {
      const losses = [...results[0]!.text.matchAll(/thread (\d+): METRIC=([0-9.]+)/g)].map((m) => ({ n: Number(m[1]), loss: Number(m[2]) }));
      const best = losses.sort((a, b) => a.loss - b.loss)[0]!;
      return call("pick", { thread: best.n, why: `thread ${best.n} has the lowest loss, ${best.loss}` }, "s2-pick");
    }
    if (results.length === 2) return call("move_to", { to: "local" }, "s2-move");
    return say("Picked. Moving back.");
  }
  if (stage === "3") {
    if (results.length === 0) return call("read_note", { path: "result.json" }, "s3-read");
    const picked = JSON.parse(results[0]!.text) as { picked: number; metric: number; settings: string };
    // Thinking is on: the earlier generations' thinking blocks are still in the context this one is given.
    const kept = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "thinking"));
    return say(`Thread ${picked.picked} won with a loss of ${picked.metric}, settings ${picked.settings}. ${kept ? "The earlier thinking is in my context." : "THINKING LOST"}`);
  }
  return say("I do not know this stage.");
}

/** The offline models and the model reference the agent uses. */
export function scriptedModels() {
  const faux = fauxProvider({ models: [{ id: MODEL.modelId, reasoning: true }] } as never);
  faux.setResponses(Array.from({ length: 400 }, () => (context: { messages: Message[] }) => brain(context)));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id } };
}
