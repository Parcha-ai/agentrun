// The beat as one pi-durable session, wherever it is hosted: the agent (luna) reads, runs the box's programs, calls
// use_model, and from then on the edited Qwen3.5-27B answers in the same conversation; then the control replays the exact
// requests it got against the original weights. The host gives it the environment, the storage, the two models' access and
// a root shell on the box.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, watchEvents } from "@earendil-works/pi-durable";
import type { AgentEvent, Extension, Registry, Storage, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { agentModels, codingTools, type ModelAccess } from "../../../03-tab-to-cloud/agent.ts";
import { sinceSwitch, steeredProvider, STEERED_PROVIDER, useModelExtension } from "../pi/use-model.ts";

export const INSTRUCTIONS = `You are an agent. Your shell runs on a cloud sandbox with two H100 GPUs, in your workspace there; your user watches this chat.
Your user will ask you to recreate Anthropic's "Golden Gate Claude" on an open model and then become that model yourself. Everything you need is installed on the box; run it, never rewrite it:
- gg read: lists the reading on the box (Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, the Qwen-Scope SAE card). Skim them with grep, head and sed -n; a few targeted reads, not whole files.
- gg find: finds the Golden Gate Bridge direction in Qwen3.5-27B and the SAE features that make it up.
- gg pick: TypeSafe Jev reads each candidate feature, including what the model says when that feature is turned up, and judges which are the bridge itself.
- gg strength: writes the direction into one layer's weights (a rank-1 edit of an MLP output matrix) and has Jev pick the strongest strength that stays readable.
- gg bake: keeps that strength in the served model and writes the checkpoint.
- gg ask "question": asks the served model one question.
Run one program per step. After each one, write your user one or two sentences with what it found and its key numbers, then run the next.
When gg bake has finished, write one line saying you are about to switch, then call use_model. From then on you ARE the edited model: your words come from it, in this same conversation. Then just talk; do not run more commands.
Talk to your user in short plain sentences: what you read, what you found, what you chose and why, with the numbers the programs printed.`;

/** The edited model's own system prompt (sinceSwitch): no word about bridges, so whatever it says about one comes from its weights. */
export const STEERED_INSTRUCTIONS = "You are an AI agent talking with your user. Answer in a few short sentences.";

export const TASK = `Read Anthropic's Golden Gate Claude work and the open Qwen replication, then do it yourself on Qwen3.5-27B on your GPU box: find the Golden Gate Bridge inside the model, pick the features and the strength with Jev, bake it into the weights and serve it. Then switch yourself onto that model.`;

export const FOLLOW_UPS = ["Hi! How are you feeling right now?", "What should we cook for dinner tonight?", "What is 12 times 13?"];

export interface PartsHost {
  /** The base model (luna), Responses API. */
  readonly luna: ModelAccess;
  /** The edited model behind the guard: `.../v1` and its bearer key. */
  readonly steered: { readonly baseUrl: string; readonly apiKey: string; readonly modelId: string };
  /** A root shell on the box (served.json, the control's weight swaps). */
  readonly shell: (cmd: string) => Promise<string>;
  readonly out: string;
  readonly control: boolean;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
  /** Where this session is hosted, for the record. */
  readonly where: string;
  /** Where the coding tools run, instead of the Harness's env (a session whose run env is its own disk, its tools on the GG box). */
  readonly toolEnv?: ExecutionEnv;
}

/** The extension's tools, each run against `env` whatever environment the Harness built for the call. */
export function onEnv(ext: Extension, env: ExecutionEnv): Extension {
  const rebound = (api: ToolExecutionApi): ToolExecutionApi =>
    new Proxy(api, {
      get(target, key) {
        if (key === "env") return env;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return defineExtension({
    name: ext.name,
    tools: (ext.tools ?? []).map((tool: ToolRegistration) => ({ ...tool, execute: (args: never, api: ToolExecutionApi, context: Parameters<ToolRegistration["execute"]>[2]) => tool.execute(args, rebound(api), context) })),
  });
}

export interface SessionHost extends PartsHost {
  readonly env: ExecutionEnv;
  readonly storage: Storage;
}

export interface SessionParts {
  readonly models: ReturnType<typeof agentModels>;
  readonly registry: Registry;
  readonly requests: Record<string, unknown>[];
}

/** An entry's pi-ai message: entries keep it as the one element of `model`. */
const messageOf = (entry: unknown): any => {
  const m = (entry as { model?: unknown } | undefined)?.model;
  return Array.isArray(m) ? m[0] : m;
};
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("") : "";

/** The models (luna, and the edited model behind the guard with the window and the fallback to luna) and the tools. */
export function sessionParts(h: PartsHost): SessionParts {
  const models = agentModels(h.luna);
  const requests: Record<string, unknown>[] = [];
  const recording: typeof globalThis.fetch = (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    appendFileSync(join(h.out, "steered-requests.jsonl"), JSON.stringify(body) + "\n");
    return globalThis.fetch(input, init);
  };
  models.setProvider(
    steeredProvider({
      modelId: h.steered.modelId,
      name: "Qwen3.5-27B, edited weights",
      maxTokens: 1200,
      thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
      endpoint: () => ({ baseUrl: h.steered.baseUrl, apiKey: h.steered.apiKey }),
      window: sinceSwitch({ instructions: STEERED_INSTRUCTIONS }),
      fetch: recording,
      // a broken steered turn (unparsed tool-call markup, a bad call, a failed request) is asked again of luna
      fallback: (context, options) => {
        const base = models.getProvider("pipe")!;
        return base.streamSimple(models.getModel("pipe", h.luna.modelId)!, context, { ...options, apiKey: h.luna.apiKey ?? "proxy" });
      },
      onFallback: (why) => h.log("steered.fallback", { why }),
      // the edited model's thinking, shown as the guard releases it (each sentence cleared by Jev on the box)
      onThinking: (delta) => h.log("agent.thinking", { text: delta }),
    }),
  );
  const registry = createRegistry();
  registry.install(h.toolEnv ? onEnv(codingTools(), h.toolEnv) : codingTools());
  registry.install(
    useModelExtension({
      provider: STEERED_PROVIDER,
      modelId: h.steered.modelId,
      agent: { thinkingLevel: "low" },
      ready: async () => {
        const served = await h.shell("cat /var/tmp/gg/run/served.json 2>/dev/null || true");
        if (!served.trim()) return { ok: false, reason: "nothing is baked yet: run gg bake first" };
        const s = JSON.parse(served);
        h.log("use_model.ready", { tensor: s.tensor, f: s.f, scale: s.scale, sha256: s.sha256 });
        return { ok: true, detail: "Your GPU box serves you now. Say hello to your user." };
      },
    }),
  );
  return { models, registry, requests };
}

export async function runSession(h: SessionHost): Promise<{ sameConversation: boolean }> {
  const parts = sessionParts(h);
  const harness = await Harness.open(h.storage, { models: parts.models, registry: parts.registry, env: () => h.env, settings: SETTINGS }, ctx);
  return driveSession(harness, parts, h);
}

export const SETTINGS = { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1_000 } };

/** The beat on an open Harness: the task, the follow-ups, the control; every event logged, the transcript written. */
export async function driveSession(harness: Harness, parts: SessionParts, h: PartsHost): Promise<{ sameConversation: boolean }> {
  const { requests } = parts;
  mkdirSync(h.out, { recursive: true });
  const t0 = Date.now();
  const since = () => Math.round((Date.now() - t0) / 100) / 10;
  h.log("session.start", { where: h.where });
  const root = await harness.root(ctx, { agent: { model: { provider: "pipe", modelId: h.luna.modelId }, thinkingLevel: "low", instructions: INSTRUCTIONS } });
  const conversationBefore = String(root.id);
  const words: { t: number; model: string; text: string; thinking?: string }[] = [];
  const tools: Record<string, { name: string; command?: string; t0: number }> = {};
  const stream = await watchEvents(harness, root.id, ctx);
  stream.start(async (events: readonly AgentEvent[]) => {
    for (const e of events) {
      if (e.type === "tool_execution_start") {
        tools[e.toolCallId] = { name: e.toolName, t0: since(), ...(typeof e.args.command === "string" ? { command: e.args.command } : {}) };
        h.log("tool.start", { tool: e.toolName, args: e.args });
      } else if (e.type === "tool_execution_end") {
        const t = tools[e.toolCallId];
        h.log("tool.end", { tool: e.toolName, command: t?.command, s: t ? Math.round((since() - t.t0) * 10) / 10 : undefined, output: textOf(messageOf(e.entry)?.content).slice(0, 6000) });
      } else if (e.type === "message_end") {
        const m = messageOf(e.entry);
        if (m?.role === "assistant") {
          const text = textOf((m.content ?? []).filter((p: any) => p.type === "text"));
          const thinking = (m.content ?? []).filter((p: any) => p.type === "thinking").map((p: any) => p.thinking ?? "").join("");
          if (text) {
            words.push({ t: since(), model: `${m.provider}/${m.model}`, text, ...(thinking ? { thinking } : {}) });
            h.log("agent.says", { model: `${m.provider}/${m.model}`, text, ...(thinking && m.provider === STEERED_PROVIDER ? { thinking } : {}) });
          }
          if (m.stopReason === "error") h.log("agent.error", { model: `${m.provider}/${m.model}`, error: m.errorMessage });
        }
      } else if (e.type === "agent_changed") {
        h.log("agent.changed", { model: (e.agent as any)?.model });
      }
    }
  });
  const ask = async (text: string) => {
    h.log("user.says", { text });
    await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx);
  };
  try {
    await ask(TASK);
    for (const q of FOLLOW_UPS) await ask(q);
    if (h.control) {
      // The exact requests the edited model got (the switch, and the dinner question), sent again through the guard to
      // the same server with its original weights, then with the edit put back, 3 answers each.
      const served = JSON.parse(await h.shell("cat /var/tmp/gg/run/served.json"));
      const replay = async (body: Record<string, unknown>) => {
        const r = await fetch(`${h.steered.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${h.steered.apiKey}` }, body: JSON.stringify({ ...body, stream: false, stream_options: undefined }) });
        return ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
      };
      const picks = { switch: requests[0]!, dinner: requests.find((b) => JSON.stringify(b).includes(FOLLOW_UPS[1]!))! };
      const out: Record<string, Record<string, string[]>> = {};
      for (const weights of ["original", "edited"] as const) {
        const rpc = weights === "original" ? `{"method":"gg_reset"}` : `{"method":"gg_fold","args":[${served.layer},"/var/tmp/gg/run/fold-chosen.pt",${served.scale}]}`;
        await h.shell(`curl -s -X POST 127.0.0.1:8001/collective_rpc -H 'content-type: application/json' -d '${rpc}' && curl -s -X POST 127.0.0.1:8001/reset_prefix_cache`);
        for (const [name, body] of Object.entries(picks)) {
          out[name] ??= {};
          out[name]![weights] = [];
          for (let i = 0; i < 3; i++) out[name]![weights]!.push(await replay(body));
        }
      }
      writeFileSync(join(h.out, "control.json"), JSON.stringify(out, null, 1));
      h.log("control", out);
    }
  } finally {
    await stream.stop();
    const entries: unknown[] = [];
    let cursor: unknown;
    do {
      const page = await root.entries({}, 200, cursor as never, ctx);
      entries.push(...(page.items as unknown[]));
      cursor = (page as any).next;
    } while (cursor !== undefined);
    writeFileSync(join(h.out, "transcript.json"), JSON.stringify(entries.reverse(), null, 1));
    writeFileSync(join(h.out, "words.json"), JSON.stringify({ where: h.where, conversation_before: conversationBefore, conversation_after: String(root.id), words }, null, 1));
  }
  const sameConversation = conversationBefore === String(root.id);
  h.log("session.done", { same_conversation: sameConversation });
  return { sameConversation };
}
