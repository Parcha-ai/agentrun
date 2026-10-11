// Runs practice tasks through pi's own agent loop (pi-agent-core's Agent) with pi's own read, write, edit and bash
// (pi-coding-agent), each task in its own directory, then checks the result in code. The brain is the teacher
// (gpt-6-luna, for practice data) or the small model behind llama-server (for scoring), decoded as the tab decodes it.
//
// Runs only in a sandbox: the tools execute whatever the model writes.
//
//   node drive.ts --instances tasks.jsonl --out runs.jsonl --brain luna [--concurrency 16]
//   node drive.ts --instances tasks.jsonl --out runs.jsonl --brain local --server http://127.0.0.1:8080 --mode grammar

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { decodeTurn, llamaServer, toPiContent, type DecodedTurn } from "../../03-tab-to-cloud/tab/decode.ts";
import { checkInstance, templateKind, type Instance } from "./tasks.ts";
import { TOOLS, renderPrompt, windowLast } from "../../03-tab-to-cloud/tab/tool-format.ts";
import { Type } from "typebox";

const { values: a } = parseArgs({
  options: {
    instances: { type: "string" },
    out: { type: "string" },
    brain: { type: "string", default: "luna" },
    server: { type: "string", default: "http://127.0.0.1:8080" },
    mode: { type: "string", default: "grammar" },
    concurrency: { type: "string", default: "8" },
    "max-calls": { type: "string", default: "12" },
    "timeout-s": { type: "string", default: "300" },
    work: { type: "string", default: "/work" },
    "think-tokens": { type: "string", default: "64" },
    "answer-tokens": { type: "string", default: "200" },
    "call-tokens": { type: "string", default: "200" },
    temperature: { type: "string", default: "0.2" },
    seed: { type: "string", default: "7" },
    thinking: { type: "string", default: "low" },
    limit: { type: "string" },
    // The commands the model's bash sees, e.g. /opt/offline-bin: the offline tab's command set (the checks keep the full PATH).
    path: { type: "string" },
    // The tools the model gets (arm B of step 2 leaves edit out), and the teacher's instructions.
    tools: { type: "string", default: "read,write,edit,bash" },
    policy: { type: "string", default: "v1" },
    // The name tool results give the task's directory ("none": keep the real path, as the first spike's data did).
    workspace: { type: "string", default: "/workspace" },
  },
});

// The teacher's instructions. Its visible text becomes the small model's thinking and answers, so they are kept short
// and regular; its own reasoning is never shown to the small model.
const RULES = `Your transcript will teach a small model, so work in a simple, regular way:
- EVERY message you write, including the last one, starts with <thinking>one short sentence: what you will do next and
  why</thinking> (at most 30 words).
- After the thinking, either call exactly ONE tool, or, when the task is done, give the final answer.`;
const FINAL = `- The final answer is one or two plain sentences, without markdown, that state the result, including any value the user
  asked for.

A final message looks like this:
<thinking>The script ran and printed 33411, so the task is done.</thinking>
sum.js prints 33411, the sum of 1 to 258.`;

/** v1: the first spike's instructions (a full Linux computer). */
const V1 = `You are a coding agent working in a sandbox directory, with four tools: read, write, edit and bash.

${RULES}
- Use read to look at a file, write to create a file or replace all of it, edit to change part of a file, and bash to run
  commands (node, ls, wc, grep, mv, cp, mkdir). Do not use bash to read or write files (no cat, echo >, sed).
- Use relative paths. Do only what the task needs; do not explore further.
- After writing or fixing a script, run it with node once to check it.
${FINAL}`;

/** The offline computer's commands (D3's inventory of the tab's edgejs.webc) and how to do common jobs with them. */
const OFFLINE = `The computer is small and offline: bash with the basic coreutils and node, nothing else. There is NO grep, sed, awk,
find, xargs, diff, python3, curl or network. Do common jobs like this:
- count the lines or words of a file: wc -l file.txt / wc -w file.txt
- line N of a file: head -n N file.txt | tail -n 1
- list files, one per line: ls -1 folder (count them: ls -1 folder/*.txt | wc -l; biggest first: ls -1S folder)
- see several small files at once, each under its name: head -n 50 *.txt
- add a line at the end of a file: echo "the line" >> file.txt (if the file may not end with a newline, for example one
  you wrote without one, read it and write the whole new content instead)
- rename or move: mv; copy: cp; make folders: mkdir -p a b
- anything else (count matching lines, sums, small transforms): a short node -e script
- run a script: node file.js
Never count, add up or pick lines in your head: run a command that prints the number or the line, then report what it
printed.
When a command or a file fails, read the error and fix the cause: look with ls -1 for a file with a similar name, make a
missing folder, fix the script, then try again. If the file the user named does not exist but one with a similar name
does, use that one and say so (for example: "There is no notes.txt; I read notes.md instead."). If the task really
cannot be done, say so plainly in the final answer; never say something worked when it did not.`;

const OFFLINE4 = `You are a coding agent working in /workspace, with four tools: read, write, edit and bash.

${OFFLINE}

${RULES}
- Use read to look at or show a file, write to create a file or replace all of it, edit to change part of a file, and
  bash for the commands above. For a small JSON file, read it and write the whole new file.
- Use relative paths. Do only what the task needs; do not explore further.
- After writing or fixing a script, run it with node once to check it.
${FINAL}`;

const OFFLINE3 = `You are a coding agent working in /workspace, with three tools: read, write and bash.

${OFFLINE}

${RULES}
- Use read to look at or show a file, write to create a file or replace all of it, and bash for the commands above. To
  change part of a file, read it and write the whole new content.
- Use relative paths. Do only what the task needs; do not explore further.
- After writing or fixing a script, run it with node once to check it.
${FINAL}`;

/** OFFLINE3 plus go_online: the request that only the cloud can serve. */
const OFFLINE3_ONLINE = OFFLINE3.replace("with three tools: read, write and bash.", "with four tools: read, write, bash and go_online.") + `
- go_online hands the work back to the cloud. Call it (after your usual one-sentence <thinking>, with no other text) when the user asks to go back
  online or to reconnect, or asks for something this offline computer cannot do: training or fine-tuning a model, using
  a GPU, making a model obsessed with something. Never call it for ordinary file or code work, even when the words
  "train", "online", "model" or "GPU" appear in a file name or a message.`;

export const TEACHER_PROMPTS: Record<string, string> = { v1: V1, offline4: OFFLINE4, offline3: OFFLINE3, offline3o: OFFLINE3_ONLINE };
if (!TEACHER_PROMPTS[a.policy!]) throw new Error(`no teacher policy ${a.policy}`);
const toolNames = a.tools!.split(",");

const work = a.work!;
const maxCalls = Number(a["max-calls"]);
const timeoutMs = Number(a["timeout-s"]) * 1000;

const models = createModels();
models.setProvider(openaiProvider());
const luna = models.getModel("openai", "gpt-6-luna");
const localModel = {
  id: "gemma-3-1b-it-tools", name: "Gemma 3 1B (tools)", api: "llama-server", provider: "local", baseUrl: a.server!,
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
} as never;
const backend = llamaServer(a.server!, { temperature: Number(a.temperature), top_k: 40, top_p: 0.95, min_p: 0.05, repeat_penalty: 1.0, seed: Number(a.seed) });
const decodeOpts = { mode: a.mode as "grammar" | "free", thinkTokens: Number(a["think-tokens"]), answerTokens: Number(a["answer-tokens"]), callTokens: Number(a["call-tokens"]) };

/** The small model as a pi stream function: render pi's context with the format, decode one turn, give pi its blocks. */
function localStream(log: DecodedTurn[], specs: typeof TOOLS) {
  let n = 0;
  return (model: any, ctx: any, opts?: { signal?: AbortSignal }) => {
    const s = createAssistantMessageEventStream();
    void (async () => {
      const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      if (opts?.signal?.aborted) {
        s.push({ type: "error", reason: "aborted", error: { ...base, content: [], usage: zero, stopReason: "aborted" } } as any);
        return;
      }
      try {
        const turn = await decodeTurn(backend, renderPrompt(specs, ctx.messages), { ...decodeOpts, tools: specs });
        log.push(turn);
        const { content, stopReason } = toPiContent(turn.parsed, `call_${++n}`);
        const usage = { input: turn.promptTokens, output: turn.outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: turn.promptTokens + turn.outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const msg = { ...base, content, usage, stopReason };
        s.push({ type: "start", partial: msg } as any);
        s.push({ type: "done", reason: stopReason, message: msg } as any);
      } catch (e) {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const msg = { ...base, content: [], usage, stopReason: "error", errorMessage: (e as Error).message };
        s.push({ type: "error", reason: "error", error: msg } as any);
      }
    })();
    return s;
  };
}

function textOf(m: any): string {
  return (m?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

/** The tab's go_online, as a stub with its exact result (D3): the turn ends at the call. */
const GO_ONLINE_RESULT = "Going online: your work is being handed back to the server. This turn ends here.";
const goOnlineTool = {
  name: "go_online", label: "go_online", description: TOOLS.find((t) => t.name === "go_online")!.summary,
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: GO_ONLINE_RESULT }], details: {} }; },
};

const usageOf = (messages: any[]) => messages.filter((m: any) => m.role === "assistant").reduce((u: any, m: any) => ({
  input: u.input + (m.usage?.input ?? 0), output: u.output + (m.usage?.output ?? 0), cacheRead: u.cacheRead + (m.usage?.cacheRead ?? 0),
  reasoning: u.reasoning + (m.usage?.reasoning ?? 0), cost: u.cost + (m.usage?.cost?.total ?? 0),
}), { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0 });
const callsIn = (messages: any[]) => messages.filter((m: any) => m.role === "assistant").flatMap((m: any) => m.content.filter((b: any) => b.type === "toolCall")).map((b: any) => ({ name: b.name, arguments: b.arguments }));

/** One request through pi's loop in `dir`, after `history` (a follow-up's window). */
async function runTask(dir: string, history: any[], prompt: string) {
  // Commands see a plain environment: no credentials of this process.
  const env = { PATH: a.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", TERM: "dumb" };
  const all = {
    read: createReadTool(dir), write: createWriteTool(dir), edit: createEditTool(dir),
    bash: createBashTool(dir, { exposeSessionEnvironment: false, spawnHook: (c) => ({ ...c, env }) }),
    go_online: goOnlineTool,
  } as Record<string, any>;
  const tools = toolNames.map((n) => all[n]);
  const specs = TOOLS.filter((t) => toolNames.includes(t.name));
  const turnsLog: DecodedTurn[] = [];
  const isLocal = a.brain === "local";
  let calls = 0, toolErrors = 0, ended = "answer";
  const agent: Agent = new Agent({
    initialState: { systemPrompt: isLocal ? "" : TEACHER_PROMPTS[a.policy!]!, model: isLocal ? localModel : luna, tools, thinkingLevel: isLocal ? "off" : (a.thinking as any), messages: history },
    streamFn: isLocal ? (localStream(turnsLog, specs) as any) : (m: any, c: any, o: any) => models.streamSimple(m, c, o),
    toolExecution: "sequential",
    // The call limit: the call past it is not run, and the run ends.
    beforeToolCall: async (): Promise<any> => {
      if (++calls <= maxCalls) return undefined;
      ended = "max-calls";
      agent.abort();
      return { block: true, reason: "call limit", terminate: true };
    },
    // Results read as they would in the tab, whose computer works in /workspace: this task's directory is renamed.
    // go_online ends the run, as the tab's tool does.
    afterToolCall: async (c: any): Promise<any> => {
      const online = c.toolCall?.name === "go_online";
      if (online) ended = "go_online";
      if (a.workspace === "none") return online ? { terminate: true } : undefined;
      return {
        content: c.result.content.map((b: any) => (b.type === "text" ? { ...b, text: b.text.replaceAll(dir, a.workspace!) } : b)),
        ...(online ? { terminate: true } : {}),
      };
    },
  });
  agent.subscribe((ev: any) => {
    if (ev.type === "tool_execution_end" && ev.isError) toolErrors++;
  });
  const timer = setTimeout(() => { ended = "timeout"; agent.abort(); }, timeoutMs);
  let error: string | undefined;
  try {
    await agent.prompt(prompt);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const messages = agent.state.messages.filter((m: any) => m.role !== "system");
  const fresh = messages.slice(history.length);
  const last: any = [...fresh].reverse().find((m: any) => m.role === "assistant");
  if (last?.stopReason === "error" && ended === "answer") { ended = "error"; error ??= last.errorMessage; }
  if (ended === "answer" && last && last.content.some((b: any) => b.type === "toolCall")) ended = "unfinished";
  if (ended === "max-calls") calls = maxCalls;
  const answer = textOf(last).replace(/^\s*<thinking>[\s\S]*?<\/thinking>\s*/, "").trim();
  return { messages, fresh, ended, error, calls, toolErrors, answer, turnsLog };
}

async function runOne(inst: Instance) {
  const dir = join(work, inst.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, body] of Object.entries(inst.files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  const t0 = Date.now();
  const isLocal = a.brain === "local";
  // A follow-up: the first task runs to its end and is checked; the second sees it through the `last` window.
  const f = inst.params.first as { template?: string; prompt: string; params: Record<string, unknown> } | undefined;
  const first = f && typeof f === "object" && typeof f.template === "string" ? (f as { template: string; prompt: string; params: Record<string, unknown> }) : undefined;
  let history: any[] = [];
  let firstRun: Awaited<ReturnType<typeof runTask>> | undefined;
  let firstWhy: string | null = null;
  if (first) {
    firstRun = await runTask(dir, [], first.prompt);
    firstWhy = checkInstance({ ...inst, template: first.template, params: first.params, prompt: first.prompt }, { dir, answer: firstRun.answer, calls: callsIn(firstRun.fresh) });
    const next = { role: "user", content: [{ type: "text", text: inst.prompt }], timestamp: Date.now() };
    history = windowLast([...firstRun.messages, next] as never).slice(0, -1);
  }
  const run = firstWhy === null ? await runTask(dir, history, inst.prompt) : undefined;
  const why = firstWhy !== null ? `first task: ${firstWhy}` : checkInstance(inst, { dir, answer: run!.answer, calls: callsIn(run!.fresh) });
  rmSync(dir, { recursive: true, force: true });
  const r = run ?? firstRun!;
  const all = [...(firstRun ? firstRun.fresh : []), ...(run ? run.fresh : [])];
  return {
    id: inst.id, template: inst.template, kind: templateKind(inst.template), split: inst.split, prompt: inst.prompt,
    brain: isLocal ? `local:${a.mode}` : "gpt-6-luna", commands: a.path ?? "full", tools: toolNames, policy: isLocal ? undefined : a.policy,
    ok: why === null, why, ended: firstWhy !== null ? "first-failed" : r.ended, error: r.error, answer: r.answer, calls: r.calls, toolErrors: r.toolErrors,
    wall_s: Math.round((Date.now() - t0) / 100) / 10, usage: usageOf(all),
    // The run as training renders it: for a follow-up, the window (first request and final answer) and the second loop.
    messages: run ? run.messages : firstRun!.messages,
    ...(firstRun ? { first: { ok: firstWhy === null, why: firstWhy, messages: firstRun.messages } } : {}),
    ...(isLocal ? { turns: [...(firstRun?.turnsLog ?? []), ...(run?.turnsLog ?? [])].map((t) => ({ raw: t.raw, problem: t.parsed.problem?.kind ?? null, thinkingCut: t.thinkingCut, cut: t.cut, promptTokens: t.promptTokens, outputTokens: t.outputTokens, thinkTokens: t.thinkTokens, completions: t.calls })), secondTurns: run?.turnsLog.length ?? 0 } : {}),
  };
}

const instances: Instance[] = readFileSync(a.instances!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const todo = a.limit ? instances.slice(0, Number(a.limit)) : instances;
mkdirSync(work, { recursive: true });
let next = 0, done = 0, passed = 0, cost = 0;
const t0 = Date.now();
async function worker() {
  while (next < todo.length) {
    const inst = todo[next++]!;
    let rec: any;
    try {
      rec = await runOne(inst);
    } catch (e) {
      rec = { id: inst.id, template: inst.template, split: inst.split, ok: false, why: `driver error: ${(e as Error).message}`, ended: "driver-error" };
    }
    appendFileSync(a.out!, JSON.stringify(rec) + "\n");
    done++; passed += rec.ok ? 1 : 0; cost += rec.usage?.cost ?? 0;
    if (done % 10 === 0 || done === todo.length) {
      console.log(JSON.stringify({ event: "progress", done, of: todo.length, passed, cost_usd: Math.round(cost * 1000) / 1000, s: Math.round((Date.now() - t0) / 1000) }));
    }
  }
}
await Promise.all(Array.from({ length: Number(a.concurrency) }, worker));
console.log(JSON.stringify({ event: "done", done, passed, cost_usd: Math.round(cost * 10000) / 10000, s: Math.round((Date.now() - t0) / 1000) }));
