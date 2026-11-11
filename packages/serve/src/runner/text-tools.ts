// Tools as text, for a model whose provider caches no prefix of a request that carries a `tools` parameter (a catalog
// entry's 'toolsAs: "text"', local-models.ts; the translated route, model-route.ts, reads it). Measured
// 2026-11-11 on OpenRouter's particle-1 (one provider, Particle AI): the same request with `tools` renders to a prompt
// whose token count varies by request (58,791 vs 58,793) and is cached 0-30% of the time; with its tools described in
// the system prompt and its calls and results written as text it is cached whole from the second send on (57,088 of
// 57,188 tokens). A tool-using review sends its whole history every turn, so that is the difference between paying
// $0.25/M (list) and $0.03/M for nearly all of its input. The text protocol is DeepSeek's DSML without its marker
// ("<function_calls><invoke name><parameter name string>"), the shape particle-1 writes on its own when given tools as
// text (DeepSeek V3.2's chat template words it so; the provider drops or breaks the `｜DSML｜` marker in what it streams);
// a reply with the marker, or a `<tool_call>{json}</tool_call>` block, is read too. Calls and results are rebuilt from
// history the same way every turn, so each request's prefix is byte for byte the last one's.

type Tool = { name: string; description?: string; parameters?: unknown };
type Part = { type: string; text?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string };
type Message = { role: string; content: Part[] | string; toolCallId?: string; toolName?: string; isError?: boolean; timestamp?: number; [key: string]: unknown };
/** A pi-ai context, as far as tools as text reads and writes it. */
export type PiContext = { systemPrompt?: string; messages: Message[]; tools?: Tool[] };

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

/** The system prompt's tools section, in DeepSeek V3.2's own words: how to call, then each tool's schema. */
export function toolsSection(tools: readonly Tool[]): string {
  return [
    "## Tools",
    "You have access to a set of tools you can use to answer the user's question.",
    'You can invoke functions by writing a "<function_calls>" block like the following as part of your reply to the user:',
    "<function_calls>",
    '<invoke name="$FUNCTION_NAME">',
    '<parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</parameter>',
    "...",
    "</invoke>",
    '<invoke name="$FUNCTION_NAME2">',
    "...",
    "</invoke>",
    "</function_calls>",
    "",
    'String and scalar parameters should be specified as is without any escaping or quotes, while lists and objects should use JSON format. The "string" attribute should be set to "true" for string type parameters and "false" for other types (numbers, booleans, arrays, objects).',
    "Several invokes in one block run together, in order. Write nothing after the block; the results come back to you in a <function_results> block. A reply with no block is your final answer.",
    "",
    "### Available Tool Schemas",
    "",
    "<functions>",
    ...tools.map((tool) => JSON.stringify({ name: tool.name, description: (tool.description ?? "").trim(), parameters: tool.parameters ?? { type: "object", properties: {} } })),
    "</functions>",
    "",
    "You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.",
  ].join("\n");
}

/** One call as a DSML invoke, as `toolsSection` asks for it. */
const invokeOf = (name: string, args: unknown): string => {
  const params = Object.entries((args && typeof args === "object" ? args : {}) as Record<string, unknown>).map(([key, value]) =>
    `<parameter name="${key}" string="${typeof value === "string"}">${typeof value === "string" ? value : JSON.stringify(value)}</parameter>`);
  return [`<invoke name="${name}">`, ...params, "</invoke>"].join("\n");
};

/** `context` with its tools in its system prompt and every tool call and result in its history written as text. */
export function toolsAsText(context: PiContext): PiContext {
  const tools = context.tools ?? [];
  const messages: Message[] = [];
  for (const message of context.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const said = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
      const calls = message.content.filter((part) => part.type === "toolCall").map((part) => invokeOf(part.name ?? "", part.arguments));
      const text = [said, calls.length ? ["<function_calls>", ...calls, "</function_calls>"].join("\n") : ""].filter(Boolean).join("\n\n");
      messages.push({ ...message, content: [{ type: "text", text: text || "(no text)" }] });
      continue;
    }
    if (message.role === "toolResult") {
      const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }];
      const body = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      const images = parts.filter((part) => part.type === "image");
      const text = `<result tool="${message.toolName ?? ""}"${message.isError ? ' error="true"' : ""}>\n${body}\n</result>`;
      // Results of one turn's calls go together, as one user message, in the order called.
      const last = messages[messages.length - 1];
      if (last?.role === "user" && last.fromTools === true && Array.isArray(last.content)) last.content.push({ type: "text", text: `\n${text}` }, ...images);
      else messages.push({ role: "user", content: [{ type: "text", text: `<function_results>\n${text}` }, ...images], timestamp: message.timestamp, fromTools: true });
      continue;
    }
    messages.push(message);
  }
  for (const message of messages) {
    if (message.fromTools === true && Array.isArray(message.content)) message.content.push({ type: "text", text: "\n</function_results>" });
    delete message.fromTools;
  }
  const system = [context.systemPrompt ?? "", tools.length ? toolsSection(tools) : ""].filter(Boolean).join("\n\n");
  return { ...(system ? { systemPrompt: system } : {}), messages };
}

/** A reply's text read as text and calls: each `<tool_call>` block whose JSON names a tool, in order; the rest is
 *  text. A block whose JSON does not parse stays text. */
export function callsOfText(said: string, tools: readonly Tool[] = []): { text: string; calls: { name: string; arguments: Record<string, unknown> }[]; broken?: boolean } {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  // DSML with its marker or without (the provider may drop it, or put zero-width spaces in its tags), as the model
  // writes it: `<function_calls>` (or "<calls>"), each `<invoke name="...">` with `<parameter name="..." string="...">`
  // values, or `<invoke name="...", "arguments": {...}}`. The slips particle-1 makes are read too: the tool named by a
  // '<parameter name="invoke">', a `<name>value</parameter>` parameter, and an invoke with no name (the one tool whose
  // schema takes every parameter given and all its required ones).
  const text = said.replace(/\u200b/g, "").replace(/｜DSML｜\s*/g, "");
  const first = text.search(/<(?:function_calls|calls|invoke\b|parameter\b)/);
  const groups: { name?: string; args: Record<string, unknown> }[] = [];
  const current = () => groups[groups.length - 1] ?? (groups.push({ args: {} }), groups[0]!);
  // A string is written unescaped, so a value may hold "</parameter>" itself (a file that writes this protocol, an
  // example in a comment): a value ends at the closing tag that the call's next tag, or the reply's end, follows.
  const token = /<invoke\s+name="([^"]+)"(\s*,\s*"arguments"\s*:\s*)?|<\/invoke>|<parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/(?:parameter|invoke)>(?=\s*(?:<parameter\s+name=|<\/?invoke\b|<\/function_calls>|<\/calls>|<[A-Za-z_][\w-]*>[^<]*<\/parameter>|$))|<([A-Za-z_][\w-]*)>([^<]*)<\/parameter>/g;
  const block = first < 0 ? "" : text.slice(first);
  let closed = false;
  // A call the reply did not finish (cut off, or a tag opened and never closed) is never run on what it holds so far:
  // the reply is broken, and asked again.
  let unfinished = false;
  let end = 0;
  for (const match of block.matchAll(token)) {
    const [whole, invoked, jsonArgs, key, isString, value, slipKey, slipValue] = match;
    if (/<(?:invoke|parameter)\b/.test(block.slice(end, match.index))) unfinished = true;
    end = match.index! + whole.length;
    if (invoked !== undefined) {
      groups.push({ name: invoked, args: {} });
      closed = false;
      if (jsonArgs) {
        const object = objectAt(block, end);
        if (object === undefined) unfinished = true;
        else {
          end += object.length;
          try {
            Object.assign(groups[groups.length - 1]!.args, JSON.parse(object));
          } catch {
            unfinished = true;
          }
        }
      }
    } else if (whole === "</invoke>") closed = true;
    else if (key === "invoke" && value!.includes("<parameter")) {
      // `<parameter name="invoke">` opening a call whose name never came: its first parameter is inside.
      groups.push({ args: {} });
      closed = false;
      const inner = /<parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*)$/.exec(value!);
      if (inner) current().args[inner[1]!] = valueOf(inner[3]!, inner[2]);
    } else if (key === "invoke" || key === "name" && current().name === undefined && tools.some((tool) => tool.name === value)) {
      groups.push({ name: value!.trim(), args: {} });
      closed = false;
    } else if (key !== undefined) {
      if (closed) groups.push({ args: {} });
      closed = false;
      current().args[key] = valueOf(value!, isString);
    } else if (slipKey !== undefined && !["function_calls", "calls", "invoke", "parameter"].includes(slipKey) && !(slipKey in current().args)) current().args[slipKey] = valueOf(slipValue!, undefined);
  }
  if (first >= 0 && /<(?:invoke|parameter)\b/.test(block.slice(end))) unfinished = true;
  if (unfinished) return { text: text.trim(), calls: [], broken: true };
  for (const group of groups) {
    const name = group.name ?? nameOf(group.args, tools);
    if (name !== undefined) calls.push({ name, arguments: group.args });
  }
  if (calls.length) return { text: text.slice(0, first).trim(), calls };
  if (first >= 0 && /<(?:function_calls|calls|invoke|parameter)\b/.test(text)) return { text: text.trim(), calls, broken: true };
  // A `<tool_call>{"name": ..., "arguments": ...}</tool_call>` block.
  let rest = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf(OPEN, at);
    if (open < 0) break;
    const close = text.indexOf(CLOSE, open + OPEN.length);
    const raw = text.slice(open + OPEN.length, close < 0 ? undefined : close).trim();
    let call: { name?: unknown; arguments?: unknown } | undefined;
    try {
      call = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
    } catch {
      call = undefined;
    }
    rest += text.slice(at, open);
    if (call && typeof call.name === "string") {
      const args = typeof call.arguments === "string" ? valueOf(call.arguments, "false") : call.arguments;
      calls.push({ name: call.name, arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown> });
    } else rest += text.slice(open, close < 0 ? undefined : close + CLOSE.length);
    if (close < 0) {
      at = text.length;
      break;
    }
    at = close + CLOSE.length;
  }
  rest += text.slice(at);
  return { text: rest.trim(), calls };
}

/** The one tool whose schema takes every argument given and all its required ones, or undefined. */
function nameOf(args: Record<string, unknown>, tools: readonly Tool[]): string | undefined {
  const keys = Object.keys(args);
  if (!keys.length) return undefined;
  const fits = tools.filter((tool) => {
    const schema = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const known = Object.keys(schema.properties ?? {});
    const props = (schema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
    return keys.every((key) => known.includes(key) && (!props[key]?.enum || props[key]!.enum!.includes(args[key]))) && (schema.required ?? []).every((key) => keys.includes(key));
  });
  return fits.length === 1 ? fits[0]!.name : undefined;
}

/** A parameter's value: as written when it is a string, else its JSON (a number, a list, an object), else as written. */
function valueOf(value: string, isString: string | undefined): unknown {
  if (isString === "true") return value;
  try {
    return JSON.parse(value.trim());
  } catch {
    return value;
  }
}

/** The JSON object that starts at `at` in `text` (its braces matched, strings skipped), or undefined. */
function objectAt(text: string, at: number): string | undefined {
  if (text[at] !== "{") return undefined;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  return undefined;
}
