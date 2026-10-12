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
 * The model's view of the conversation's tools when the model comes with a serving file (the system prompt and the tools it was trained and scored on): the
 * serving file's tools, verbatim and in its order, those the conversation offers; nothing else (a registry tool the model never saw is not shown, and a serving
 * tool the conversation does not offer is not either, so every call it can make is one pi can run). With no serving file, the conversation's own tools.
 */
export function servingView(tools: readonly ToolChatTool[], serving: readonly ToolChatTool[] | undefined): ToolChatTool[] {
  if (!serving || serving.length === 0) return [...tools];
  const offered = new Set(tools.map((t) => t.function.name));
  return serving.filter((t) => offered.has(t.function.name));
}

/**
 * The tools a signature prefix lists, in its order (D1's v5 serving file has no tools: its system text gives each tool as one line, `name(args): what it does`).
 */
export function signatureTools(system: string): string[] {
  return [...system.matchAll(/^([a-z][a-z0-9_]*)\(/gm)].map((m) => m[1]!);
}

/**
 * The values a signature prefix offers each tool's parameters, where its line lists them (`part: torso|legs|all`): a free text or a number (`name: string`,
 * `factor: number 0.5..2.0`) lists none.
 */
export function signatureEnums(system: string): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const m of system.matchAll(/^([a-z][a-z0-9_]*)\(([^)]*)\)/gm)) {
    const params: Record<string, string[]> = {};
    for (const arg of m[2]!.split(/,\s*/)) {
      const at = arg.indexOf(":");
      const values = arg.slice(at + 1).trim();
      if (at > 0 && values.includes("|")) params[arg.slice(0, at).trim()] = values.split("|").map((v) => v.trim());
    }
    out[m[1]!] = params;
  }
  return out;
}

/**
 * The tools a request is locked to (D1's rule for v5 and V5T, robot_eval's build_gbnf over v6_lock.py's tools): each parameter cut to the values the prompt's
 * signature line offers (v5's names four parts, V5T's sixteen tags), then, on a body written as code, set_color's and set_shape's part cut to that body's tags
 * (and all, for set_color), and do's skill to the skills that came home. A tool left with an empty choice is dropped (do when none of the skills home is one the
 * prompt names, set_shape when none of a code body's tags is). The registry's own schemas stay wider, so every host agrees
 * on them; this is the model's view, and the grammar built from it is the lock.
 */
export function robotLock(tools: readonly ToolChatTool[], o: { system: string; home: readonly string[]; tags?: readonly string[] }): ToolChatTool[] {
  const offered = signatureEnums(o.system);
  return tools.flatMap((tool) => {
    let t = tool;
    for (const [property, values] of Object.entries(offered[t.function.name] ?? {})) t = narrowEnum([t], property, values)[0]!;
    if (o.tags && (t.function.name === "set_color" || t.function.name === "set_shape")) t = narrowEnum([t], "part", [...o.tags, "all"])[0]!;
    if (t.function.name === "do") t = narrowEnum([t], "skill", o.home)[0]!;
    // a tool with nothing left to choose is not offered: do when no skill the prompt names came home (none, or only custom-named ones), set_shape on a code
    // body whose tags the prompt does not name; an empty choice is a grammar nothing satisfies
    const props = (t.function.parameters as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties ?? {};
    return Object.values(props).some((p) => Array.isArray(p.enum) && p.enum.length === 0) ? [] : [t];
  });
}

/** The model's view for a signature prefix: the conversation's tools that the prefix names, in its order; nothing else. */
export function signatureView(tools: readonly ToolChatTool[], names: readonly string[]): ToolChatTool[] {
  return names.flatMap((n) => tools.filter((t) => t.function.name === n));
}

/**
 * The tools with the enum of one property cut down to `allowed` (every tool that has such a property): what a small model is offered. The registry's own tools keep the whole list so every host
 * agrees; this narrowing is the model's view only, e.g. the skills that actually came home. The runtime builds its call grammar from the schema it is sent, so the narrowed enum is a lock.
 */
export function narrowEnum(tools: readonly ToolChatTool[], property: string, allowed: readonly string[]): ToolChatTool[] {
  return tools.map((t) => {
    const params = t.function.parameters as { properties?: Record<string, { enum?: unknown[]; pattern?: string }> } | undefined;
    const prop = params?.properties?.[property];
    if (!prop) return t;
    // a property with an enum is cut down to `allowed`; a free string (a skill the cluster named) becomes an enum of exactly `allowed`: the model's view is what came home, whatever the registry's schema accepts
    const { pattern: _pattern, ...rest } = prop;
    const narrowed = prop.enum ? { ...prop, enum: prop.enum.filter((v) => allowed.includes(String(v))) } : { ...rest, enum: [...allowed] };
    return { ...t, function: { ...t.function, parameters: { ...params, properties: { ...params!.properties, [property]: narrowed } } } };
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
 * The window of D1's spec T7 (ROBOT-WINDOW-SPEC): the conversation's earlier exchanges in the model's own format, then ONE assistant message holding the robot's
 * state line, then the current task (the user's turn, and this model's calls and their results since). An earlier exchange is the user's message, this model's
 * calls (content "", tool_calls) and their results (the tools' literal texts), then its final reply text; thinking is never shown back, and an exchange this model
 * did not answer is left out. While `fits` says no, the oldest whole exchange is dropped (D1: while the rendered prompt is over 2048 - 400 tokens). The system
 * prompt and the tools come first and never change, so a warm state made at the end of the system turn holds for every turn.
 */
export function nativeExchanges(messages: readonly unknown[], o: WindowOptions & { system?: string; refine?: (tools: ToolChatTool[]) => ToolChatTool[]; stateLine?: string; fits?: (messages: ToolChatMessage[], tools: ToolChatTool[]) => boolean }): NativeTurn {
  const tools = (o.refine ?? ((t: ToolChatTool[]) => t))(nativeTools(messages));
  type M = { role: string; provider?: string; content?: unknown; toolCallId?: string };
  const real = (messages as M[]).filter((m) => m.role !== "system");
  const exchanges: M[][] = [];
  for (const m of real) {
    if (m.role === "user" || exchanges.length === 0) exchanges.push([]);
    exchanges.at(-1)!.push(m);
  }
  const own = (ex: M[]): ToolChatMessage[] => {
    const calls = new Set<string>();
    const out: ToolChatMessage[] = [];
    for (const m of ex) {
      if (m.role === "user") out.push(...toMessages(m as unknown as Msg));
      else if (m.role === "assistant" && m.provider === o.provider) {
        for (const b of (Array.isArray(m.content) ? m.content : []) as { type?: string; id?: string }[]) if (b.type === "toolCall" && b.id) calls.add(b.id);
        out.push(...toMessages(m as unknown as Msg));
      } else if (m.role === "toolResult" && calls.has(m.toolCallId ?? "")) out.push(...toMessages(m as unknown as Msg));
    }
    return out;
  };
  const current = exchanges.pop() ?? [];
  let earlier = exchanges.map(own).filter((ex) => ex[0]?.role === "user" && ex.some((m) => m.role === "assistant"));
  const now = own(current);
  const steps = now.filter((m) => m.role === "assistant").length;
  const system: ToolChatMessage[] = o.system ? [{ role: "system", content: o.system }] : [];
  const state: ToolChatMessage[] = o.stateLine ? [{ role: "assistant", content: o.stateLine }] : [];
  const build = () => [...system, ...earlier.flat(), ...state, ...now];
  let dropped = 0;
  while (earlier.length > 0 && o.fits && !o.fits(build(), tools)) { earlier = earlier.slice(1); dropped++; }
  return { messages: build(), tools, steps, dropped };
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
