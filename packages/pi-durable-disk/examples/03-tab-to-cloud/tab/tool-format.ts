// The one tool-call format for the small model (Gemma 3 1B): the training export renders kept trajectories with it, and
// the tab-local provider renders prompts and parses replies with it, so what the model learned is what it is asked.
//
//   first user turn   the tool spec, a blank line, then the user's request (Gemma has no system role)
//   model turn        <thinking>short plan</thinking>\n<tool_call>{"name":...,"arguments":{...}}</tool_call>
//                     or <thinking>short plan</thinking>\n final answer
//   result            a user turn: <tool_result name="bash">output</tool_result> (error="true" when the tool failed)
//
// One call per model turn. Calls are compact JSON with the arguments in schema order, so a call has one byte form; the
// grammar (callGrammar) accepts exactly that form, and the provider switches to it once "<tool_call>" opens. Tool
// results are canonical (canonicalResult): the same text whether pi-coding-agent's tools or pi-durable's produced them.
//
// No dependencies: messages and tools are typed structurally, compatible with pi-ai's Message and Tool.

export const FORMAT = "self-tools-v1";

export const TURN_USER = "<start_of_turn>user\n";
export const TURN_MODEL = "<start_of_turn>model\n";
export const TURN_END = "<end_of_turn>\n";
export const END_OF_TURN = "<end_of_turn>";
export const THINK_OPEN = "<thinking>";
export const THINK_CLOSE = "</thinking>";
export const CALL_OPEN = "<tool_call>";
export const CALL_CLOSE = "</tool_call>";

/** Tool output longer than this is cut in the middle (head and tail kept), the same way in training and in the tab. */
export const RESULT_MAX_CHARS = 1600;
/** The teacher's thinking is kept to this many words in training data; the tab caps generated thinking in tokens. */
export const THINK_MAX_WORDS = 40;

// ---------------------------------------------------------------------------------------------------------------------
// The tools: pi's read, write, edit and bash, with the argument schemas of @earendil-works/pi-coding-agent 1.0.4
// (descriptions shortened for a small model's context), and the tab's go_online. Property order is the canonical
// argument order.

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  description?: string;
}

export interface ToolSpec {
  name: string;
  summary: string;
  parameters: JsonSchema;
}

const str: JsonSchema = { type: "string" };
const num: JsonSchema = { type: "number" };

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "read",
    summary: "Read a text file. offset is the first line (1-based), limit the number of lines.",
    parameters: { type: "object", properties: { path: str, offset: num, limit: num }, required: ["path"] },
  },
  {
    name: "write",
    summary: "Create or overwrite a file with content. Parent directories are created.",
    parameters: { type: "object", properties: { path: str, content: str }, required: ["path", "content"] },
  },
  {
    name: "edit",
    summary: "Change a file by exact text replacement. Each oldText must appear exactly once in the file.",
    parameters: {
      type: "object",
      properties: {
        path: str,
        edits: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: { oldText: str, newText: str }, required: ["oldText", "newText"] },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "bash",
    summary: "Run a bash command in the working directory and get its output. timeout is in seconds.",
    parameters: { type: "object", properties: { command: str, timeout: num }, required: ["command"] },
  },
  {
    // The tab's tool (D3): no arguments; the turn ends at the call and the cloud model continues the conversation.
    name: "go_online",
    summary: "Go back online: hand the work in this browser back to the server so the cloud model can continue it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** A host's tool (pi-ai's Tool: name, description, parameters as JSON Schema). */
export interface HostTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * The format's tools that the host offers, in the format's order. Throws when a host tool with one of the four names has
 * different argument names than the format was trained on (the spec and grammar would then lie to the model).
 * Host tools outside the four are not shown to the model.
 */
export function selectTools(host: readonly HostTool[]): ToolSpec[] {
  const offered = new Map(host.map((t) => [t.name, t]));
  const out: ToolSpec[] = [];
  for (const spec of TOOLS) {
    const h = offered.get(spec.name);
    if (!h) continue;
    const props = (h.parameters as JsonSchema | undefined)?.properties;
    if (props) {
      const want = Object.keys(spec.parameters.properties ?? {}).sort().join(",");
      const got = Object.keys(props).sort().join(",");
      if (want !== got) throw new Error(`tool ${spec.name}: the host's arguments (${got}) differ from the format's (${want})`);
    }
    out.push(spec);
  }
  return out;
}

function typeText(s: JsonSchema): string {
  if (s.type === "array") return `[${typeText(s.items ?? {})}, ...]`;
  if (s.type === "object") {
    const req = new Set(s.required ?? []);
    return `{${Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeText(v)}`).join(", ")}}`;
  }
  return s.type ?? "any";
}

/** The tool spec that opens the first user turn. */
export function renderSpec(tools: readonly ToolSpec[] = TOOLS): string {
  const lines = tools.map((t) => {
    const req = new Set(t.parameters.required ?? []);
    const args = Object.entries(t.parameters.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeText(v)}`);
    return `- ${t.name}(${args.join(", ")}): ${t.summary}`;
  });
  return [
    "You are a coding agent with tools. To use a tool, think briefly, then make exactly one call:",
    `${THINK_OPEN}what you will do next${THINK_CLOSE}`,
    `${CALL_OPEN}{"name":"write","arguments":{"path":"notes.txt","content":"hello\\n"}}${CALL_CLOSE}`,
    `The result comes back as <tool_result name="...">...</tool_result>. When the task is done, think briefly and then`,
    "answer the user without a tool call. Paths are relative to the working directory.",
    "",
    "Tools:",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages (structurally pi-ai's).

export interface TextBlock { type: "text"; text: string }
export interface ThinkingBlock { type: "thinking"; thinking: string; redacted?: boolean }
export interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
export interface UserMsg { role: "user"; content: string | readonly ({ type: string; text?: string })[] }
export interface AssistantMsg { role: "assistant"; content: readonly (TextBlock | ThinkingBlock | ToolCallBlock | { type: string })[] }
export interface ToolResultMsg { role: "toolResult"; toolCallId: string; toolName: string; content: readonly ({ type: string; text?: string })[]; isError: boolean }
export type Msg = UserMsg | AssistantMsg | ToolResultMsg | { role: string };

function plainText(content: UserMsg["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/**
 * Arguments in the tool's schema order (unknown keys last, in their own order), recursively for objects in arrays.
 * A null argument is left out: some providers send unused optional arguments as null, and pi treats both the same.
 */
function ordered(schema: JsonSchema | undefined, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => ordered(schema?.items, v));
  if (!value || typeof value !== "object") return value;
  const props = schema?.properties ?? {};
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const present = (k: string) => v[k] !== undefined && v[k] !== null;
  for (const k of Object.keys(props)) if (present(k)) out[k] = ordered(props[k], v[k]);
  for (const k of Object.keys(v)) if (!(k in out) && present(k)) out[k] = v[k];
  return out;
}

/** A call's one byte form: compact JSON, name first, arguments in schema order. */
export function renderCall(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ name, arguments: ordered(BY_NAME.get(name)?.parameters, args) });
}

/** Tool output as the model sees it: cut in the middle past RESULT_MAX_CHARS. */
export function clipResult(text: string, max = RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters cut ...]\n${text.slice(text.length - tail)}`;
}

/** bash output longer than BASH_HEAD_LINES + BASH_TAIL_LINES lines keeps its first and last lines. */
export const BASH_HEAD_LINES = 10;
export const BASH_TAIL_LINES = 10;

/** pi-durable's Harness reports a failed tool as its output followed by this block (measured on the tab's computer). */
const HARNESS_ERROR = /\n?<harness>\n\[error\] ([\s\S]*?)\n<\/harness>\s*$/;
/** pi-coding-agent's bash puts the status after the output and a blank line. */
const BASH_STATUS = /^([\s\S]*?)\n*(Command (?:exited with code \d+|timed out after [\d.]+ seconds|aborted))$/;

/** First and last lines of a long text, with the count of the lines between. */
export function capLines(text: string, head = BASH_HEAD_LINES, tail = BASH_TAIL_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= head + tail) return text;
  return [...lines.slice(0, head), `[... ${lines.length - head - tail} lines cut ...]`, ...lines.slice(lines.length - tail)].join("\n");
}

/**
 * A node crash as the model reads it, whichever host ran node: the stack frames that point into the runtime (the
 * browser's wasmer URLs, a Linux node's internals) are dropped, frames in the user's /workspace files are kept, and so
 * are the runtime's banner and version lines.
 */
function cleanNodeError(out: string): string {
  return out.split("\n")
    .filter((l) => !/^Failed to execute builtin '[^']*':$/.test(l) && !/^Node\.js v\d+[\d.]*\S*$/.test(l))
    .filter((l) => !/^\s+at /.test(l) || l.includes("/workspace/"))
    .join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * One text for a tool's result, whichever pi stack produced it: pi-coding-agent's tools (the training data) or
 * pi-durable's CodingTools in the Harness (the tab). The Harness's error block is unwrapped; bash reads as its output,
 * a blank line, then "Command exited with code N"; empty output reads "(no output)"; a missing file reads
 * "<path>: not found"; node crashes lose the runtime's stack frames; long bash output keeps its first and last lines.
 */
export function canonicalResult(name: string, text: string): string {
  let out = text;
  let status = "";
  const h = HARNESS_ERROR.exec(out);
  if (h) {
    out = out.slice(0, h.index);
    status = h[1]!.trim();
  } else if (name === "bash") {
    const e = BASH_STATUS.exec(out);
    if (e) { out = e[1]!; status = e[2]!; }
  }
  const missing = /^ENOENT: no such file or directory, \w+ '(.+)'$/.exec((status || out).trim());
  if (missing) { status = `${missing[1]}: not found`; out = ""; }
  if (name === "bash") {
    out = cleanNodeError(out).replace(/\s+$/, "");
    if (out === "(no output)") out = "";
    const body = capLines(out) || "(no output)";
    return status ? `${body}\n\n${status}` : body;
  }
  if (!status) return out;
  return out.trim() ? `${out.replace(/\s+$/, "")}\n\n${status}` : status;
}

export function renderResult(name: string, text: string, isError: boolean): string {
  return `<tool_result name="${name}"${isError ? ' error="true"' : ""}>${clipResult(canonicalResult(name, text))}</tool_result>`;
}

/** One model turn's text (without the turn markers). */
export function renderModelTurn(turn: { thinking: string; call?: { name: string; arguments: Record<string, unknown> }; answer?: string }): string {
  const think = `${THINK_OPEN}${turn.thinking.trim()}${THINK_CLOSE}\n`;
  if (turn.call) return `${think}${CALL_OPEN}${renderCall(turn.call.name, turn.call.arguments)}${CALL_CLOSE}`;
  return `${think}${(turn.answer ?? "").trim()}`;
}

interface Turn { role: "user" | "model"; text: string }

function turns(tools: readonly ToolSpec[], messages: readonly Msg[]): Turn[] {
  const out: Turn[] = [];
  const pushUser = (text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.text += `\n\n${text}`;
    else out.push({ role: "user", text });
  };
  // Several calls in one message become one model turn each, each followed by its result (matched by call id); the
  // thinking goes with the first. A call still waiting for its result is rendered only once the result arrives.
  let queue: ToolCallBlock[] = [];
  const results = new Map<string, ToolResultMsg>();
  const flush = () => {
    while (queue.length && results.has(queue[0]!.id)) {
      const r = results.get(queue[0]!.id)!;
      results.delete(queue[0]!.id);
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      pushUser(renderResult(r.toolName, text, r.isError));
      queue.shift();
      if (queue.length) out.push({ role: "model", text: renderModelTurn({ thinking: "", call: queue[0]! }) });
    }
  };
  let first = true;
  for (const m of messages) {
    if (m.role === "toolResult") {
      const r = m as ToolResultMsg;
      if (queue.some((c) => c.id === r.toolCallId)) {
        results.set(r.toolCallId, r);
        flush();
      } else {
        const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        pushUser(renderResult(r.toolName, text, r.isError));
      }
      continue;
    }
    // Anything else ends the calls of the previous message; one never answered is left out.
    queue = [];
    results.clear();
    if (m.role === "user") {
      const text = plainText((m as UserMsg).content);
      pushUser(first ? `${renderSpec(tools)}\n\n${text}` : text);
      first = false;
    } else if (m.role === "assistant") {
      const blocks = (m as AssistantMsg).content;
      const thinking = blocks
        .filter((b): b is ThinkingBlock => b.type === "thinking" && !(b as ThinkingBlock).redacted)
        .map((b) => b.thinking.trim()).filter(Boolean).join(" ");
      const answer = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      const calls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
      if (!calls.length) out.push({ role: "model", text: renderModelTurn({ thinking, answer }) });
      else {
        out.push({ role: "model", text: renderModelTurn({ thinking, call: calls[0]! }) });
        queue = calls;
      }
    }
  }
  return out;
}

/**
 * The `last` window: the current task with the previous one in front of it, as the tab shows the small model a follow-up.
 * The previous task keeps its request and its final answer (thinking and text) and loses its tool loop; a previous task
 * that did not end in an answer, or whose answer another model wrote (`own` says which are this model's), is left out.
 * Messages before the previous task are left out too.
 */
export function windowLast(messages: readonly Msg[], own: (m: AssistantMsg) => boolean = () => true): Msg[] {
  const users = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  const cur = users[users.length - 1];
  if (cur === undefined) return [...messages];
  const current = messages.slice(cur);
  const prev = users[users.length - 2];
  if (prev === undefined) return current;
  const final = messages.slice(prev + 1, cur).filter((m) => m.role === "assistant").pop() as AssistantMsg | undefined;
  if (!final || !own(final) || final.content.some((b) => b.type === "toolCall")) return current;
  const kept = final.content.filter((b) => b.type === "thinking" || b.type === "text");
  return [messages[prev]!, { ...final, content: kept } as Msg, ...current];
}

/** The prompt for the next model turn (no <bos>: the tokenizer adds it, in training and in llama.cpp alike). */
export function renderPrompt(tools: readonly ToolSpec[], messages: readonly Msg[]): string {
  return renderTranscript(tools, messages).text + TURN_MODEL;
}

/**
 * A whole conversation as training text, with the character spans the loss is taken on: each model turn's text and
 * the <end_of_turn> that ends it.
 */
export function renderTranscript(tools: readonly ToolSpec[], messages: readonly Msg[]): { text: string; train: [number, number][] } {
  let text = "";
  const train: [number, number][] = [];
  for (const t of turns(tools, messages)) {
    if (t.role === "user") {
      text += `${TURN_USER}${t.text}${TURN_END}`;
    } else {
      text += TURN_MODEL;
      const start = text.length;
      text += t.text + END_OF_TURN;
      train.push([start, text.length]);
      text += "\n";
    }
  }
  return { text, train };
}

/**
 * Training spans in Unicode code points, the unit a training row's `train` spans use on disk (Python indexes strings by
 * code point; JavaScript's offsets count UTF-16 units, so any character outside the BMP, an emoji, would shift them).
 */
export function codePointSpans(text: string, spans: readonly [number, number][]): [number, number][] {
  // Code points before each UTF-16 offset, in one pass.
  const at = new Int32Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    at[i] = cp;
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { at[++i] = cp; }
    cp++;
  }
  at[text.length] = cp;
  return spans.map(([a, b]) => [at[a]!, at[b]!]);
}

/** A training row as it is written to disk: the text and the loss spans in code points. */
export function trainingRow(text: string, train: readonly [number, number][]): { text: string; train: [number, number][]; units: "codepoint" } {
  return { text, train: codePointSpans(text, train), units: "codepoint" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing a model turn back into pi's blocks.

export type CallProblem = "no-close" | "bad-json" | "not-an-object" | "unknown-tool" | "bad-args";

export interface ParsedTurn {
  thinking: string;
  /** Set when the turn opened a call. */
  call?: { name: string; arguments: Record<string, unknown> };
  /** Why the opened call is unusable (the turn then counts as an invalid call, not an answer). */
  problem?: { kind: CallProblem; detail: string; raw: string };
  answer: string;
}

/** Whether a call body is whole JSON (the test that finds the real closing tag: a string argument may contain it). */
export function isWholeJson(body: string): boolean {
  try { JSON.parse(body); return true; } catch { return false; }
}

/** Where a call that opens at `open` closes: the first closing tag after which the body is whole JSON, else the first one, else -1. */
function closeOf(text: string, open: number): { close: number; first: number } {
  const first = text.indexOf(CALL_CLOSE, open);
  for (let c = first; c >= 0; c = text.indexOf(CALL_CLOSE, c + 1)) {
    if (isWholeJson(text.slice(open + CALL_OPEN.length, c))) return { close: c, first };
  }
  return { close: -1, first };
}

/** The thinking, and either a call or the final answer, from a generated model turn (without <end_of_turn>). */
export function parseModelTurn(raw: string): ParsedTurn {
  // A turn ends at <end_of_turn>, but not one inside a call's JSON (a write may save a transcript).
  const eot = raw.indexOf(END_OF_TURN);
  const open = raw.indexOf(CALL_OPEN);
  let rest = raw;
  if (eot >= 0 && (open < 0 || eot < open)) rest = raw.slice(0, eot);
  else if (open >= 0) {
    const { close } = closeOf(raw, open);
    const after = close >= 0 ? raw.indexOf(END_OF_TURN, close) : -1;
    if (after >= 0) rest = raw.slice(0, after);
  }
  let thinking = "";
  const t0 = rest.indexOf(THINK_OPEN);
  if (t0 >= 0 && rest.slice(0, t0).trim() === "") {
    const t1 = rest.indexOf(THINK_CLOSE, t0);
    if (t1 >= 0) {
      thinking = rest.slice(t0 + THINK_OPEN.length, t1).trim();
      rest = rest.slice(t1 + THINK_CLOSE.length);
    } else {
      // Unclosed thinking: whatever comes before a call is thinking.
      const c = rest.indexOf(CALL_OPEN, t0);
      thinking = rest.slice(t0 + THINK_OPEN.length, c >= 0 ? c : undefined).trim();
      rest = c >= 0 ? rest.slice(c) : "";
    }
  }
  const c0 = rest.indexOf(CALL_OPEN);
  if (c0 < 0) return { thinking, answer: rest.trim() };
  const before = rest.slice(0, c0).trim();
  // The call ends at the first closing tag after which the body is JSON: a string argument may itself contain the tag.
  const { close: c1, first } = closeOf(rest, c0);
  const body = rest.slice(c0 + CALL_OPEN.length, c1 >= 0 ? c1 : first >= 0 ? first : undefined).trim();
  const fail = (kind: CallProblem, detail: string): ParsedTurn => ({ thinking, answer: before, problem: { kind, detail, raw: body } });
  if (first < 0) return fail("no-close", "the call was not closed");
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return fail("bad-json", (e as Error).message);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("not-an-object", "the call is not a JSON object");
  const { name, arguments: args } = v as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || !BY_NAME.has(name)) return fail("unknown-tool", `no tool named ${JSON.stringify(name)}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("bad-args", "arguments is not an object");
  const errs = validate(BY_NAME.get(name)!.parameters, args, "arguments");
  if (errs.length) return fail("bad-args", errs.join("; "));
  return { thinking, call: { name, arguments: args as Record<string, unknown> }, answer: before };
}

/** Schema errors for a value (the subset the four tools use). */
export function validate(s: JsonSchema, v: unknown, at: string): string[] {
  switch (s.type) {
    case "string":
      return typeof v === "string" ? [] : [`${at} must be a string`];
    case "number":
    case "integer":
      return typeof v === "number" && Number.isFinite(v) ? [] : [`${at} must be a number`];
    case "boolean":
      return typeof v === "boolean" ? [] : [`${at} must be a boolean`];
    case "array": {
      if (!Array.isArray(v)) return [`${at} must be an array`];
      if (s.minItems && v.length < s.minItems) return [`${at} needs at least ${s.minItems} item(s)`];
      return v.flatMap((x, i) => validate(s.items ?? {}, x, `${at}[${i}]`));
    }
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at} must be an object`];
      const o = v as Record<string, unknown>;
      const props = s.properties ?? {};
      const errs = (s.required ?? []).filter((k) => !(k in o)).map((k) => `${at}.${k} is missing`);
      for (const k of Object.keys(o)) {
        if (!(k in props)) errs.push(`${at}.${k} is not an argument`);
        else errs.push(...validate(props[k]!, o[k], `${at}.${k}`));
      }
      return errs;
    }
    default:
      return [];
  }
}

/** For a rewrite that must keep calls (D2): a turn's thinking, call body (exact bytes) and answer. */
export function splitTurn(text: string): { thinking: string; call: string | null; answer: string } {
  const p = parseModelTurn(text);
  const c0 = text.indexOf(CALL_OPEN);
  const { close, first } = c0 >= 0 ? closeOf(text, c0) : { close: -1, first: -1 };
  const c1 = close >= 0 ? close : first;
  return { thinking: p.thinking, call: c0 >= 0 && c1 >= 0 ? text.slice(c0 + CALL_OPEN.length, c1) : null, answer: p.answer };
}

// ---------------------------------------------------------------------------------------------------------------------
// The grammar: GBNF (llama.cpp's, as wllama's `grammar` sampler takes it) for what follows "<tool_call>": one call in
// its canonical byte form, then "</tool_call>".

function q(s: string): string {
  return JSON.stringify(s); // a GBNF literal: double-quoted, with backslash escapes
}

/**
 * The grammar for one call to any of `tools`, from right after "<tool_call>" through "</tool_call>". `withOpen`: the root starts with "<tool_call>" itself, for a LAZY grammar
 * whose trigger is that word (llama.cpp feeds the grammar from the trigger word on).
 */
export function callGrammar(tools: readonly ToolSpec[] = TOOLS, opts: { withOpen?: boolean } = {}): string {
  const rules: string[] = [];
  const ruleFor = (name: string, s: JsonSchema): string => {
    switch (s.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "int";
      case "boolean":
        return '("true" | "false")';
      case "array": {
        const item = ruleFor(`${name}-item`, s.items ?? {});
        return s.minItems ? `"[" ${item} ("," ${item})* "]"` : `"[" (${item} ("," ${item})*)? "]"`;
      }
      case "object": {
        const req = new Set(s.required ?? []);
        const entries = Object.entries(s.properties ?? {});
        // Canonical order; optional keys may be left out, so every comma belongs to the key after it except the first
        // key's (always required in these schemas).
        let body = "";
        entries.forEach(([k, v], i) => {
          const sep = i === 0 ? "" : ",";
          const part = `${q(`${sep}${JSON.stringify(k)}:`)} ${ruleFor(`${name}-${k}`, v)}`;
          body += req.has(k) ? ` ${part}` : ` (${part})?`;
        });
        if (entries.length && !req.has(entries[0]![0])) throw new Error(`${name}: the first property must be required`);
        const rule = `${name}-obj`;
        rules.push(`${rule} ::= "{"${body} "}"`);
        return rule;
      }
      default:
        throw new Error(`${name}: unsupported schema type ${s.type}`);
    }
  };
  const alts = tools.map((t) => {
    // GBNF rule names are letters, digits and hyphens (go_online's underscore is not allowed).
    const r = ruleFor(`${t.name.replace(/[^A-Za-z0-9-]/g, "-")}-args`, t.parameters);
    return `${q(`{"name":${JSON.stringify(t.name)},"arguments":`)} ${r} "}"`;
  });
  return [
    `root ::= ${opts.withOpen ? `${q(CALL_OPEN)} ` : ""}(${alts.join(" | ")}) ${q(CALL_CLOSE)}`,
    ...rules,
    `string ::= "\\"" char* "\\""`,
    `char ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])`,
    `int ::= "0" | [1-9] [0-9]*`,
  ].join("\n") + "\n";
}
