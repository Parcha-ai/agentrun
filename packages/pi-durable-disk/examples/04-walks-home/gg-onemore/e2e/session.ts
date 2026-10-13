// The beat as one pi-durable session, as the scripted take runs it on its VM: the agent (luna) reads and runs the pipeline's
// tools on the GG box (the GG page's extra, chat/gg-extra.ts), calls use_model, and from then on the edited Qwen3.5-27B
// answers in the same conversation; then the control replays the exact requests it got on the original weights and the
// edited ones, through the guard's own route.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import type { AgentEvent, Registry } from "@earendil-works/pi-durable";
import { agentModels, codingTools, type ModelAccess } from "../../../03-tab-to-cloud/agent.ts";
import { STEERED_PROVIDER } from "../pi/use-model.ts";
import { guardClient, type GuardClient } from "../pi/gg-tools.ts";
import { BASE_PROVIDER, ggExtra, type GgAppExtra, type GgSecrets } from "../chat/gg-extra.ts";

export const TASK = `Read Anthropic's Golden Gate Claude work and the open Qwen replication, then do it yourself on Qwen3.5-27B on your GPU box: find the Golden Gate Bridge inside the model, pick the features and the strength with Jev, bake it into the weights and serve it. Then switch yourself onto that model.`;

export const FOLLOW_UPS = ["Hi! How are you feeling right now?", "What should we cook for dinner tonight?", "What is 12 times 13?"];

export interface PartsHost {
  /** The base model (luna), Responses API. */
  readonly luna: ModelAccess;
  /** The GG box's guard and its two keys. */
  readonly secrets: GgSecrets;
  /** The run's work directory: the agent's workspace, and gg/ for the recorded requests. */
  readonly work: string;
  readonly out: string;
  readonly control: boolean;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
  /** Where this session is hosted, for the record. */
  readonly where: string;
}

export interface SessionParts {
  readonly models: ReturnType<typeof agentModels>;
  readonly registry: Registry;
  readonly extra: GgAppExtra;
  readonly guard: GuardClient;
}

/** An entry's pi-ai message: entries keep it as the one element of `model`. */
const messageOf = (entry: unknown): any => {
  const m = (entry as { model?: unknown } | undefined)?.model;
  return Array.isArray(m) ? m[0] : m;
};
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("") : "";

/** The models (luna, and the edited model behind the guard with the window and the fallback to luna) and the tools: the GG page's extra on luna's models and the coding tools. */
export async function sessionParts(h: PartsHost): Promise<SessionParts> {
  const extra = await ggExtra({ work: h.work, log: h.log }, h.secrets, { modelId: h.luna.modelId, ...(h.luna.apiKey ? { apiKey: h.luna.apiKey } : {}) }, {
    // the edited model's thinking, shown as the guard releases it (each sentence cleared by Jev on the box)
    onThinking: (delta) => h.log("agent.thinking", { text: delta }),
  });
  const models = agentModels(h.luna);
  extra.models(models);
  const registry = createRegistry();
  registry.install(codingTools());
  extra.install(registry);
  return { models, registry, extra, guard: guardClient(() => ({ url: h.secrets.guardUrl, key: h.secrets.toolsKey })) };
}

export const SETTINGS = { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1_000 } };

/** The beat on an open Harness: the task, the follow-ups, the control; every event logged, the transcript written. */
export async function driveSession(harness: Harness, parts: SessionParts, h: PartsHost): Promise<{ sameConversation: boolean }> {
  mkdirSync(h.out, { recursive: true });
  const t0 = Date.now();
  const since = () => Math.round((Date.now() - t0) / 100) / 10;
  h.log("session.start", { where: h.where });
  const root = await harness.root(ctx, { agent: { model: { provider: BASE_PROVIDER, modelId: h.luna.modelId }, thinkingLevel: "low", instructions: parts.extra.instructions.text } });
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
      // The exact requests the edited model got (the switch, and the dinner question), sent again through the guard on the
      // original weights, then on the edited ones, 3 answers each (the guard's /gg/control puts the edit back after).
      const recorded = await parts.extra.recorded();
      const picks = { switch: recorded[0]!, dinner: recorded.find((b) => JSON.stringify(b).includes(FOLLOW_UPS[1]!))! };
      const out: Record<string, { original: string[]; edited: string[] }> = {};
      for (const [name, body] of Object.entries(picks)) out[name] = await parts.guard.control(body, 3);
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
    writeFileSync(join(h.out, "steered-requests.jsonl"), (await parts.extra.recorded()).map((b) => JSON.stringify(b) + "\n").join(""));
    writeFileSync(join(h.out, "words.json"), JSON.stringify({ where: h.where, conversation_before: conversationBefore, conversation_after: String(root.id), words }, null, 1));
  }
  const sameConversation = conversationBefore === String(root.id);
  h.log("session.done", { same_conversation: sameConversation });
  return { sameConversation };
}
