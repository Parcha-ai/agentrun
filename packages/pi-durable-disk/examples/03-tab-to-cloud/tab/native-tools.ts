// A native tool turn LOCKED to the tools' schemas: the `toolChat` of a model that runs in this page. The model's own chat template (the jinja its GGUF carries)
// renders the conversation and its tools exactly as llama.cpp's server would (checked byte for byte against llama-server's /apply-template), the completion runs
// under a grammar that holds every tool, argument, enum, range and length (D1's "true lock", robot_eval.py `build_gbnf`), and the reply is parsed back into calls.
// Why not wllama's createChatCompletion with `tools`: llama.cpp's own tool grammar fixes a call's structure and the tool names but leaves argument values free
// text (D1 measured "purpel", "cat", factor 3), and it refuses a custom grammar next to `tools`. So the template is rendered here and the completion is a raw one.
// Format: Qwen's XML calls (`<tool_call>\n<function=NAME>\n<parameter=K>\nV\n</parameter>\n</function>\n</tool_call>`), the format of D1's robot fine-tune.
// Portable: no Node API.
import { Template } from "@huggingface/jinja";
import type { RawRequest, RawResult, ToolChatMessage, ToolChatRequest, ToolChatResult, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";

export interface JsonSchema { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; description?: string }

/** The prompt for the next turn: the model's own template over the messages and the tools (a call's arguments as an object, as the template reads them). */
export function renderNative(template: string, messages: readonly ToolChatMessage[], tools: readonly ToolChatTool[], kwargs: Record<string, unknown> = {}): string {
  const chat = messages.map((m) => (m.role === "assistant" && m.tool_calls ? { ...m, content: m.content ?? "", tool_calls: m.tool_calls.map((c) => ({ ...c, function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } })) } : m));
  return new Template(template).render({
    messages: chat as unknown as Record<string, unknown>[],
    ...(tools.length > 0 ? { tools: JSON.parse(JSON.stringify(tools)) as Record<string, unknown>[] } : {}),
    add_generation_prompt: true,
    bos_token: "",
    eos_token: "",
    ...kwargs,
  }); // the engine's own raise_exception throws with the template's message
}

const parseArgs = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; } };

// ---- the lock ------------------------------------------------------------------------------------------------------

const lit = (s: string) => JSON.stringify(s);
const ruleName = (s: string) => s.replace(/[^a-z0-9]/g, "-");

/** One argument's values. Enums are the listed values only; the robot's factors (0.5 to 2) are that range in at most two decimals. */
function valueRule(tool: string, key: string, p: JsonSchema): string {
  if (p.enum) return p.enum.map((v) => lit(String(v))).join(" | ");
  if (p.type === "number" && p.minimum === 0.5 && p.maximum === 2) return '"0." [5-9] [0-9]? | "1" ("." [0-9] [0-9]?)? | "2" (".0" "0"?)?';
  if (p.type === "number") return '"-"? [0-9]{1,6} ("." [0-9]{1,4})?';
  if (p.type === "integer") return '"-"? [0-9]{1,6}';
  if (p.type === "boolean") return '"true" | "false"';
  if (p.type === "string") { // D1's form: one character, then up to max - 1 more (the grammar the fine-tune was scored with, byte for byte)
    const max = Math.max(1, p.maxLength ?? 64), min = Math.max(1, p.minLength ?? 1);
    return min === 1 ? `[^<\\n] [^<\\n]{0,${max - 1}}` : `[^<\\n]{${min},${max}}`;
  }
  throw new Error(`the lock has no rule for ${tool}.${key} (${JSON.stringify(p).slice(0, 80)})`);
}

const permutations = <T>(xs: readonly T[]): T[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

/**
 * The GBNF that admits one to six calls of these tools with in-schema arguments, or a plain answer that does not start a tag. A tool whose arguments are all
 * required (and at most four) takes them in any order; otherwise in schema order, the optional ones optional.
 */
export function lockGrammar(tools: readonly ToolChatTool[]): string {
  const rules: string[] = [];
  const calls: string[] = [];
  for (const t of tools) {
    const name = t.function.name;
    const parameters = (t.function.parameters ?? {}) as JsonSchema;
    const rn = ruleName(name);
    const props = Object.entries(parameters.properties ?? {});
    const required = new Set(parameters.required ?? []);
    for (const [k, p] of props) rules.push(`${rn}-${ruleName(k)} ::= ${valueRule(name, k, p)}`);
    const param = (k: string) => `"<parameter=${k}>\\n" ${rn}-${ruleName(k)} "\\n</parameter>\\n"`;
    const keys = props.map(([k]) => k);
    const args = keys.length === 0 ? ['""'] : keys.every((k) => required.has(k)) && keys.length <= 4 ? permutations(keys).map((order) => `(${order.map(param).join(" ")})`) : [keys.map((k) => (required.has(k) ? param(k) : `(${param(k)})?`)).join(" ")];
    rules.push(`${rn}-args ::= ${args.join(" | ")}`);
    calls.push(`"<tool_call>\\n<function=${name}>\\n" ${rn}-args "</function>\\n</tool_call>"`);
  }
  const head = ["root ::= calls | answer", 'calls ::= call ("\\n" call){0,5}', `call ::= ${calls.join(" | ")}`, "answer ::= [^<] [^<]*"];
  return `${[...head, ...rules].join("\n")}\n`;
}

// ---- the reply -----------------------------------------------------------------------------------------------------

/**
 * The calls in a reply (each argument typed by its schema), and the text around them. A call to an unknown tool is kept: the Harness answers it as unknown. Only
 * finished calls count: a reply cut by its token limit inside a call (`<function=reset>` and no more) is no call at all (`unfinished`), never run with what it had.
 */
export function parseNative(text: string, tools: readonly ToolChatTool[]): { calls: { name: string; arguments: Record<string, unknown> }[]; text: string; unfinished: boolean } {
  const schemas = new Map(tools.map((t) => [t.function.name, (t.function.parameters ?? {}) as JsonSchema]));
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    const fn = /<function=([\w-]+)>[\s\S]*<\/function>/.exec(m[1]!);
    if (!fn) continue;
    const props = schemas.get(fn[1]!)?.properties ?? {};
    const args: Record<string, unknown> = {};
    for (const p of m[1]!.matchAll(/<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      const key = p[1]!, raw = p[2]!.trim(), type = props[key]?.type;
      args[key] = type === "number" || type === "integer" ? (Number.isFinite(Number(raw)) ? Number(raw) : raw) : type === "boolean" ? raw === "true" : raw;
    }
    calls.push({ name: fn[1]!, arguments: args });
  }
  const finished = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  const unfinished = finished.includes("<tool_call>");
  const rest = finished.replace(/<tool_call>[\s\S]*$/, "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { calls, text: rest, unfinished };
}

/**
 * A `toolChat` (ToolChatRequest in, ToolChatResult out) over a model's raw completion and its own template, locked: the shape the native provider calls. With no
 * tools the turn is a plain answer under the template, no grammar. `onTurn` sees the prompt and the raw reply (for the page's stats and the checks).
 */
/**
 * `lock`: the tools the grammar holds, when they differ from the tools the prompt shows (D1's rule: the prompt keeps the full tools, so a warm state made for it
 * holds, while the grammar is built over the narrowed ones: do's skills cut to the ones that came home, do dropped when none has).
 */
export function lockedToolChat(model: { template(): string | null; complete(req: RawRequest, signal: AbortSignal): Promise<RawResult>; /** The system text lists the tools (a signature prefix): the prompt has no tools block; the grammar and the parse still hold them. */ bare?: () => boolean }, onTurn?: (t: { prompt: string; raw: string; grammar: boolean; result: ToolChatResult; timings?: Record<string, number> }) => void, lock?: (tools: ToolChatTool[]) => ToolChatTool[]) {
  return async (req: ToolChatRequest, signal?: AbortSignal): Promise<ToolChatResult> => {
    const template = model.template();
    if (!template) throw new Error("this model has no chat template of its own: a native tool turn needs one");
    const tools = req.toolChoice === "none" ? [] : req.tools;
    const prompt = renderNative(template, req.messages, model.bare?.() ? [] : tools, req.templateKwargs ?? { enable_thinking: false });
    const locked = lock ? lock([...tools]) : tools;
    const grammar = tools.length > 0 ? lockGrammar(locked) : undefined;
    const started = performance.now();
    const r = await model.complete({ prompt, maxTokens: req.maxTokens, ...(grammar ? { grammar } : {}) }, signal ?? new AbortController().signal);
    const parsed = parseNative(r.text, locked);
    const stamp = `call-${Date.now().toString(36)}`;
    const result: ToolChatResult = {
      text: parsed.text,
      // a reply cut inside a call runs none of its calls: what was cut is not what the model meant
      toolCalls: (parsed.unfinished ? [] : parsed.calls).map((c, i) => ({ id: `${stamp}-${i}`, name: c.name, arguments: JSON.stringify(c.arguments) })),
      stoppedBy: parsed.unfinished || r.stoppedBy === "length" && parsed.calls.length === 0 ? "length" : parsed.calls.length > 0 ? "tool_calls" : "stop",
      promptTokens: r.promptTokens,
      outputTokens: r.outputTokens,
      ms: performance.now() - started,
    };
    onTurn?.({ prompt, raw: r.text, grammar: grammar !== undefined, result, ...(r.timings ? { timings: r.timings } : {}) });
    return result;
  };
}
