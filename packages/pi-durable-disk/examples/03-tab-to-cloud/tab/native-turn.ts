// A turn for a model that has its OWN tool template (MiniCPM5-2B, and the like): the model's jinja renders the tools and the conversation, and the model answers in its own call syntax, which the
// runtime (wllama over llama.cpp) parses into tool_calls. So this module only turns pi's transcript into OpenAI-shaped messages and tools, and the model's reply back into pi's blocks; nothing of
// D1's trained format (tool-format.ts) is involved. The window is the same one the trained 1B is shown (tool-window.ts: the current task, this model's own turns and the results of its calls),
// fitted to the context by dropping the oldest complete call/result pairs. Pure.
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ToolChatMessage, ToolChatResult, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";
import { windowMessages, type WindowOptions } from "./tool-window.ts";
import type { Msg } from "./tool-format.ts";

export interface NativeTurn { messages: ToolChatMessage[]; tools: ToolChatTool[]; /** The model's own turns in this task before any pair was dropped. */ steps: number; dropped: number }

/** The conversation's tools as OpenAI function tools: name, description and the JSON schema as pi holds it (an enum in a schema is a lock the runtime turns into a grammar). */
export function nativeTools(messages: readonly unknown[]): ToolChatTool[] {
  return toNativeTools(getCurrentTools(messages as never) as { name: string; description?: string; parameters?: unknown }[]);
}

/** pi tool registrations (or the agent's tools) as OpenAI function tools. */
export function toNativeTools(list: readonly { name: string; description?: string; parameters?: unknown }[]): ToolChatTool[] {
  return list.map((t) => ({
    type: "function" as const,
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: JSON.parse(JSON.stringify(t.parameters ?? { type: "object", properties: {} })) },
  }));
}

/**
 * The tools with the enum of one property cut down to `allowed` (every tool that has such a property): what a small model is offered. The registry's own tools keep the whole list so every host
 * agrees; this narrowing is the model's view only, e.g. the skills that actually came home. The runtime builds its call grammar from the schema it is sent, so the narrowed enum is a lock.
 */
export function narrowEnum(tools: readonly ToolChatTool[], property: string, allowed: readonly string[]): ToolChatTool[] {
  return tools.map((t) => {
    const params = t.function.parameters as { properties?: Record<string, { enum?: unknown[] }> } | undefined;
    const prop = params?.properties?.[property];
    if (!prop?.enum) return t;
    return { ...t, function: { ...t.function, parameters: { ...params, properties: { ...params!.properties, [property]: { ...prop, enum: prop.enum.filter((v) => allowed.includes(String(v))) } } } } };
  });
}

const textOf = (content: unknown): string => (Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : typeof content === "string" ? content : "");

/** One window message as OpenAI messages: the model's thinking is not shown back (a native template thinks, or not, on its own), its calls are tool_calls, results are tool messages. */
function toMessages(m: Msg): ToolChatMessage[] {
  const x = m as unknown as { role: string; content?: unknown; toolCallId?: string };
  if (x.role === "user") return [{ role: "user", content: textOf(x.content) }];
  if (x.role === "toolResult") return [{ role: "tool", tool_call_id: x.toolCallId ?? "", content: textOf(x.content) }];
  if (x.role === "assistant") {
    const blocks = (Array.isArray(x.content) ? x.content : []) as { type?: string; id?: string; name?: string; arguments?: unknown }[];
    const calls = blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: String(b.id), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.arguments ?? {}) } }));
    return [{ role: "assistant", content: textOf(x.content), ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
  }
  return [];
}

const charsOf = (messages: readonly ToolChatMessage[], tools: readonly ToolChatTool[]) => JSON.stringify(messages).length + JSON.stringify(tools).length;

/**
 * The messages and tools of the next turn. `maxChars` bounds the whole prompt (the tools included, they are rendered into it): while it is over, the oldest complete turn of the model and the results
 * that answer it are dropped, never the request and never the newest turn.
 */
export function nativeTurn(messages: readonly unknown[], o: WindowOptions & { system?: string; maxChars?: number; /** The model's view of the tools (see narrowEnum). */ refine?: (tools: ToolChatTool[]) => ToolChatTool[] }): NativeTurn {
  const tools = (o.refine ?? ((t: ToolChatTool[]) => t))(nativeTools(messages));
  const window = windowMessages(messages as never, o);
  const user = window.map((m) => m.role).lastIndexOf("user");
  const steps = window.slice(user + 1).filter((m) => m.role === "assistant").length;
  const system: ToolChatMessage[] = o.system ? [{ role: "system", content: o.system }] : [];
  let body = window.flatMap(toMessages);
  let dropped = 0;
  while (o.maxChars !== undefined && charsOf([...system, ...body], tools) > o.maxChars) {
    const u = body.map((m) => m.role).lastIndexOf("user");
    const first = body.findIndex((m, i) => i > u && m.role === "assistant");
    const end = body.findIndex((m, i) => i > first && m.role === "assistant");
    if (first < 0 || end < 0) break; // the only turn is the newest: it stays
    body = [...body.slice(0, first), ...body.slice(end)];
    dropped++;
  }
  return { messages: [...system, ...body], tools, steps, dropped };
}

/**
 * The model's reply as pi's content: its own call syntax already parsed by the runtime into tool_calls (arguments as JSON text), else what the runtime left in the text (MiniCPM's special-token
 * tags come back stripped: ` name="morph"> name="preset">spider`); a call whose arguments are not JSON is no call. Thinking tags are split off into a thinking block.
 */
export function nativeContent(r: Pick<ToolChatResult, "text" | "toolCalls">, toolNames: readonly string[], properties: Readonly<Record<string, readonly string[]>> = {}): { content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[]; calls: number; problems: string[] } {
  const content: ReturnType<typeof nativeContent>["content"] = [];
  const problems: string[] = [];
  let text = r.text;
  const think = /<think>([\s\S]*?)(?:<\/think>|$)/.exec(text);
  if (think) {
    if (think[1]!.trim()) content.push({ type: "thinking", thinking: think[1]!.trim() });
    text = text.replace(think[0], "");
  }
  let calls = r.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  if (calls.length === 0) {
    const parsed = parseTaggedCalls(text, toolNames, properties);
    if (parsed.length > 0) { calls = parsed.map((c, i) => ({ id: `call-${i}`, name: c.name, arguments: JSON.stringify(c.arguments) })); text = ""; }
  }
  if (text.trim()) content.push({ type: "text", text: text.trim() });
  for (const c of calls) {
    let args: unknown;
    try { args = JSON.parse(c.arguments || "{}"); } catch { problems.push(`${c.name}: the arguments are not JSON`); continue; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { problems.push(`${c.name}: the arguments are not an object`); continue; }
    content.push({ type: "toolCall", id: c.id, name: c.name, arguments: args as Record<string, unknown> });
  }
  return { content, calls: content.filter((b) => b.type === "toolCall").length, problems };
}

/** The argument names of each tool, from the schemas the model was shown: what tells an argument from the next call when a tool and an argument share a name (update_robot's `reset`, `morph` and `scale`). */
export function toolProperties(tools: readonly ToolChatTool[]): Record<string, string[]> {
  return Object.fromEntries(tools.map((t) => [t.function.name, Object.keys((t.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})]));
}

/**
 * MiniCPM5's calls when its tags come back stripped: a key that is an argument of the call being read is its argument (even when it is also a tool's name: update_robot has a `reset` and a `morph`),
 * else a name that is a tool starts a call, any other name="..."> key is an argument of the current call; numbers and booleans are parsed.
 */
export function parseTaggedCalls(text: string, toolNames: readonly string[], properties: Readonly<Record<string, readonly string[]>> = {}): { name: string; arguments: Record<string, unknown> }[] {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const parts = text.split(/\s*name="([\w-]+)">/);
  let current: { name: string; arguments: Record<string, unknown> } | undefined;
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i]!;
    const value = (parts[i + 1] ?? "").trim();
    const isArgument = current !== undefined && (properties[current.name] ?? []).includes(key) && !(key in current.arguments);
    if (!isArgument && toolNames.includes(key) && !(current && key in current.arguments)) { current = { name: key, arguments: {} }; calls.push(current); continue; }
    if (!current) continue;
    current.arguments[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;
  }
  return calls;
}
