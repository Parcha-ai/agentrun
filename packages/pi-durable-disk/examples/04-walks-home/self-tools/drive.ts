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
import { TOOLS, renderPrompt } from "../../03-tab-to-cloud/tab/tool-format.ts";

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
    "call-tokens": { type: "string", default: "512" },
    temperature: { type: "string", default: "0.2" },
    seed: { type: "string", default: "7" },
    thinking: { type: "string", default: "low" },
    limit: { type: "string" },
  },
});

// The teacher's instructions. Its visible text becomes the small model's thinking and answers, so they are kept short
// and regular; its own reasoning is never shown to the small model.
export const TEACHER_PROMPT = `You are a coding agent working in a sandbox directory, with four tools: read, write, edit and bash.

Your transcript will teach a small model, so work in a simple, regular way:
- EVERY message you write, including the last one, starts with <thinking>one short sentence: what you will do next and
  why</thinking> (at most 30 words).
- After the thinking, either call exactly ONE tool, or, when the task is done, give the final answer.
- Use read to look at a file, write to create a file or replace all of it, edit to change part of a file, and bash to run
  commands (node, ls, wc, grep, mv, cp, mkdir). Do not use bash to read or write files (no cat, echo >, sed).
- Use relative paths. Do only what the task needs; do not explore further.
- After writing or fixing a script, run it with node once to check it.
- The final answer is one or two plain sentences, without markdown, that state the result, including any value the user
  asked for.

A final message looks like this:
<thinking>The script ran and printed 33411, so the task is done.</thinking>
sum.js prints 33411, the sum of 1 to 258.`;

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
function localStream(log: DecodedTurn[]) {
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
        const turn = await decodeTurn(backend, renderPrompt(TOOLS, ctx.messages), decodeOpts);
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

async function runOne(inst: Instance) {
  const dir = join(work, inst.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, body] of Object.entries(inst.files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  // Commands see a plain environment: no credentials of this process.
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", TERM: "dumb" };
  const tools = [createReadTool(dir), createWriteTool(dir), createEditTool(dir),
    createBashTool(dir, { exposeSessionEnvironment: false, spawnHook: (c) => ({ ...c, env }) })];
  const turnsLog: DecodedTurn[] = [];
  const isLocal = a.brain === "local";
  let calls = 0, toolErrors = 0, ended = "answer";
  const agent: Agent = new Agent({
    initialState: { systemPrompt: isLocal ? "" : TEACHER_PROMPT, model: isLocal ? localModel : luna, tools, thinkingLevel: isLocal ? "off" : (a.thinking as any) },
    streamFn: isLocal ? (localStream(turnsLog) as any) : (m: any, c: any, o: any) => models.streamSimple(m, c, o),
    toolExecution: "sequential",
    // The call limit: the call past it is not run, and the run ends.
    beforeToolCall: async (): Promise<any> => {
      if (++calls <= maxCalls) return undefined;
      ended = "max-calls";
      agent.abort();
      return { block: true, reason: "call limit", terminate: true };
    },
  });
  agent.subscribe((ev: any) => {
    if (ev.type === "tool_execution_end" && ev.isError) toolErrors++;
  });
  const t0 = Date.now();
  const timer = setTimeout(() => { ended = "timeout"; agent.abort(); }, timeoutMs);
  let error: string | undefined;
  try {
    await agent.prompt(inst.prompt);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const messages = agent.state.messages.filter((m: any) => m.role !== "system");
  const last: any = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (last?.stopReason === "error" && ended === "answer") { ended = "error"; error ??= last.errorMessage; }
  if (ended === "answer" && last && last.content.some((b: any) => b.type === "toolCall")) ended = "unfinished";
  if (ended === "max-calls") calls = maxCalls;
  const answer = textOf(last).replace(/^\s*<thinking>[\s\S]*?<\/thinking>\s*/, "").trim();
  const why = checkInstance(inst, { dir, answer });
  const usage = messages.filter((m: any) => m.role === "assistant").reduce((u: any, m: any) => ({
    input: u.input + (m.usage?.input ?? 0), output: u.output + (m.usage?.output ?? 0), cacheRead: u.cacheRead + (m.usage?.cacheRead ?? 0),
    reasoning: u.reasoning + (m.usage?.reasoning ?? 0), cost: u.cost + (m.usage?.cost?.total ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0 });
  rmSync(dir, { recursive: true, force: true });
  return {
    id: inst.id, template: inst.template, kind: templateKind(inst.template), split: inst.split, prompt: inst.prompt,
    brain: isLocal ? `local:${a.mode}` : "gpt-6-luna", ok: why === null, why, ended, error, answer, calls, toolErrors,
    wall_s: Math.round((Date.now() - t0) / 100) / 10, usage, messages,
    ...(isLocal ? { turns: turnsLog.map((t) => ({ raw: t.raw, problem: t.parsed.problem?.kind ?? null, thinkingCut: t.thinkingCut, cut: t.cut, promptTokens: t.promptTokens, outputTokens: t.outputTokens, thinkTokens: t.thinkTokens })) } : {}),
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
