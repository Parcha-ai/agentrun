// A stand-in for the cloud model, for a check that has none: the provider `pipe` answering from a script, one turn per model request. It is installed by the page's `demo.stubCloud`
// (a hook for checks; a page without it never has it) and records what each request carried, so a check can say what the cloud model was shown. Portable: no Node API.
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, Provider, TranscriptContext, Usage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { PROVIDER } from "../agent.ts";

/** One answer: some text, or a tool call (with the text said before it). */
/** `id`: the call's id, when a test needs one that repeats (the browser's brain names its calls call-0, call-1 in every turn). */
type ScriptedCall = { name: string; arguments: Record<string, string | number | boolean | null>; id?: string };
/** One reply: text, one call, or several calls made in the same turn (pi runs those together). `reply`: text written
 * from the instructions the request carried, for a check of what the instructions make a model say. */
export type ScriptedTurn = { text?: string; reply?: (instructions: string) => string; call?: ScriptedCall; calls?: ScriptedCall[] };

/** What a request carried: the roles of the messages, the start of the system prompt, the names of the tools offered, and the last user text. */
export interface SeenRequest {
  model: string;
  roles: string[];
  system: string;
  tools: string[];
  lastUser: string;
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("") : "");

/** `provider`: the provider id it answers as (the cloud model's by default; a check of the browser's model passes BRAIN_PROVIDER). */
export function scriptedCloud(modelId: string, script: ScriptedTurn[], seen: SeenRequest[], provider: string = PROVIDER): Provider {
  let next = 0;
  const run = (model: Model<string>, context: TranscriptContext | Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: "stop", timestamp: Date.now() };
    const messages = context.messages as { role: string; content?: unknown }[];
    // the system prompt and the tools are system messages in the transcript (deltas): read them the way a provider does
    const tools = (getCurrentTools(messages as never) as { name: string }[]).map((t) => t.name);
    const instructions = String(getCurrentSystemPrompt(messages as never) ?? "");
    const system = instructions.replace(/\s+/g, " ").slice(0, 160);
    seen.push({ model: model.id, roles: messages.map((m) => m.role), system, tools, lastUser: textOf([...messages].reverse().find((m) => m.role === "user")?.content) });
    const turn = script[Math.min(next++, script.length - 1)] ?? { text: "(no script)" };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: output });
      const text = turn.reply ? turn.reply(instructions) : turn.text;
      if (text) {
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      }
      const calls = [...(turn.call ? [turn.call] : []), ...(turn.calls ?? [])];
      calls.forEach((c, i) => {
        const call = { type: "toolCall" as const, id: c.id ?? `scripted-${next}${i ? `-${i}` : ""}`, name: c.name, arguments: c.arguments };
        const at = output.content.push(call) - 1;
        stream.push({ type: "toolcall_start", contentIndex: at, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: at, toolCall: call, partial: output });
        output.stopReason = "toolUse";
      });
      stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message: output });
      stream.end();
    });
    return stream;
  };
  return createProvider({
    id: provider,
    name: "Scripted cloud model",
    auth: { apiKey: { name: "scripted", resolve: async () => ({ auth: { apiKey: modelId } }) } },
    models: [{ id: modelId, name: modelId, api: "openai-responses", provider, baseUrl: "scripted:", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_000 }],
    api: { stream: run as never, streamSimple: run as never },
  });
}
