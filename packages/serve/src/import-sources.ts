// The sessions Claude Code, Codex and pi keep under a person's home, read as one shape: where each ran, on which model,
// when, how it ended, what it cost when the source says, and its turns. Each reader reads one JSONL file a line at a
// time; a line that is not JSON, or not a record it knows, is passed over.
//   Claude Code  ~/.claude/projects/<cwd slug>/<session id>.jsonl (a subagent's file, in <session id>/subagents/, is not read)
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   pi           ~/.pi/agent/sessions/--<cwd>--/<time>_<session id>.jsonl
import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export const SOURCES = ["claude-code", "codex", "pi"] as const;
export type Source = (typeof SOURCES)[number];
/** The harness of serve that runs what each source ran. */
export const HARNESS_OF: Record<Source, string> = {
  "claude-code": "claude-agent",
  codex: "codex",
  pi: "pi",
};

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type Turn =
  | { role: "user"; text: string; at: number }
  | {
      role: "assistant";
      text: string;
      calls: ToolCall[];
      at: number;
      costUsd?: number;
      key?: string;
    }
  | {
      role: "toolResult";
      callId: string;
      name: string;
      text: string;
      isError: boolean;
      at: number;
    };
export type Ended = "completed" | "failed" | "stopped";

export type Session = {
  source: Source;
  /** The source's own id for the session. */
  id: string;
  file: string;
  cwd?: string;
  /** "provider/model", from the session's latest model. */
  model?: string;
  startedAt?: string;
  endedAt?: string;
  state: Ended;
  /** The whole session's cost, when the source records it; absent is unknown. */
  costUsd?: number;
  firstPrompt?: string;
  /** A subagent's or another session's child: not imported. */
  child: boolean;
  /** Read only when asked for: a dry run reads none. */
  turns: Turn[];
  users: number;
};

/** The session files of `source` under `home`, never through a link. */
export async function sessionFiles(home: string, source: Source): Promise<string[]> {
  const entries = async (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  if (source === "claude-code") {
    const root = join(home, ".claude", "projects");
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      for (const file of await entries(join(root, project.name))) if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(root, project.name, file.name));
    }
  } else if (source === "codex") {
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await entries(dir)) {
        if (entry.isDirectory() && depth < 3) await walk(join(dir, entry.name), depth + 1);
        else if (entry.isFile() && depth === 3 && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(join(dir, entry.name));
      }
    };
    await walk(join(home, ".codex", "sessions"), 0);
  } else {
    const root = join(home, ".pi", "agent", "sessions");
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      for (const file of await entries(join(root, project.name))) if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(root, project.name, file.name));
    }
  }
  // A home whose source directory is itself a link is read as found (the person's own), but no file is a link.
  const files: string[] = [];
  for (const file of out.sort()) if ((await lstat(file).catch(() => null))?.isFile()) files.push(file);
  return files;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const timeOf = (value: unknown): number | undefined => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
};
/** Text from a string or a list of blocks; a block that is not text says what it was. */
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return isObject(value) && typeof value.text === "string" ? value.text : "";
  return value
    .map((block) => (typeof block === "string" ? block : isObject(block) ? (typeof block.text === "string" ? block.text : block.type === "image" || block.type === "input_image" ? "[image]" : textOf(block.content)) : ""))
    .filter(Boolean)
    .join("\n");
};
const argsOf = (value: unknown): Record<string, unknown> => {
  if (isObject(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isObject(parsed)) return parsed;
    } catch {
      // Not JSON: kept as the tool's one input.
    }
    return { input: value };
  }
  return {};
};

/** One session file of `source`, read whole; `turns: false` keeps only what a listing shows. */
export async function readSession(file: string, source: Source, { turns: keep = true }: { turns?: boolean } = {}): Promise<Session> {
  const session: Session = {
    source,
    id: "",
    file,
    state: "completed",
    child: false,
    turns: [],
    users: 0,
  };
  const turns: Turn[] = [];
  let first: number | undefined;
  let last: number | undefined;
  const names = new Map<string, string>();
  const priced = { sum: 0, unknown: false };
  const provider: { name?: string } = {};
  const codex: Into["codex"] = { events: false, held: [] };
  const add = (turn: Turn, index = turns.length) => {
    if (turn.role === "user") {
      session.users += 1;
      session.firstPrompt ??= turn.text;
    }
    if (keep) turns.splice(index, 0, turn);
  };
  const record = source === "claude-code" ? claudeRecord : source === "codex" ? codexRecord : piRecord;
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    const at = timeOf(value.timestamp);
    if (at !== undefined) {
      first ??= at;
      last = at;
    }
    record(value, at ?? last ?? 0, session, { add, names, turns, priced, provider, codex });
  }
  // Older Codex writes each of the person's turns twice, as a user_message event and as a user message; current Codex
  // writes the user message alone. One source per file, so no turn counts twice.
  if (!codex.events) codex.held.forEach(({ index, turn }, k) => add(turn, index + k));
  if (!session.id) session.id = source === "pi" ? basename(file, ".jsonl").split("_").pop()! : basename(file, ".jsonl");
  if (first !== undefined) session.startedAt = new Date(first).toISOString();
  if (last !== undefined) session.endedAt = new Date(last).toISOString();
  session.turns = turns;
  return session;
}

type Into = {
  add: (turn: Turn) => void;
  names: Map<string, string>;
  turns: Turn[];
  priced: { sum: number; unknown: boolean };
  /** Codex's model provider, from its session_meta, for the model its turns name. */
  provider: { name?: string };
  /** Codex: whether the file has user_message events, and its user messages, each with its place among the turns, held to the file's end. */
  codex: { events: boolean; held: { index: number; turn: Turn }[] };
};

const INTERRUPTED = /^\[Request interrupted by user/;

function claudeRecord(value: Record<string, unknown>, at: number, session: Session, { add, names, turns }: Into): void {
  if (!session.id && str(value.sessionId)) session.id = value.sessionId as string;
  if (!session.cwd && str(value.cwd)) session.cwd = value.cwd as string;
  if (value.isSidechain === true) session.child = true;
  if (value.type === "cost-state") {
    // The last one is the session's: unknown when the CLI could not price a model it used.
    session.costUsd = typeof value.totalCostUSD === "number" && Number.isFinite(value.totalCostUSD) && value.totalCostUSD >= 0 && value.hasUnknownModelCost !== true ? value.totalCostUSD : undefined;
    return;
  }
  if ((value.type !== "user" && value.type !== "assistant") || !isObject(value.message)) return;
  if (value.isMeta === true || value.isCompactSummary === true || value.isVisibleInTranscriptOnly === true) return;
  const message = value.message;
  if (value.type === "assistant") {
    const model = str(message.model);
    if (model && model !== "<synthetic>") session.model = `anthropic/${model}`;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: textOf(message.content) }];
    const text = blocks
      .filter((b) => isObject(b) && b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const calls: ToolCall[] = blocks
      .filter((b): b is Record<string, unknown> => isObject(b) && b.type === "tool_use")
      .map((b) => ({
        type: "toolCall",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        arguments: argsOf(b.input),
      }));
    for (const call of calls) names.set(call.id, call.name);
    session.state = value.isApiErrorMessage === true ? "failed" : "completed";
    if (!text && calls.length === 0) return;
    // One request's blocks come as records of one message id: one turn.
    const key = str(message.id);
    const previous = turns.at(-1);
    if (key && previous?.role === "assistant" && previous.key === key) {
      previous.text = [previous.text, text].filter(Boolean).join("\n");
      previous.calls.push(...calls);
      return;
    }
    add({ role: "assistant", text, calls, at, ...(key ? { key } : {}) });
    return;
  }
  if (typeof message.content === "string") {
    if (INTERRUPTED.test(message.content)) session.state = "stopped";
    else session.state = "completed";
    return add({ role: "user", text: message.content, at });
  }
  if (!Array.isArray(message.content)) return;
  const said: string[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") said.push(block.text);
    else if (block.type === "tool_result") {
      const id = String(block.tool_use_id ?? "");
      add({
        role: "toolResult",
        callId: id,
        name: names.get(id) ?? "",
        text: textOf(block.content),
        isError: block.is_error === true,
        at,
      });
    }
  }
  if (said.length) {
    const text = said.join("\n");
    session.state = INTERRUPTED.test(text) ? "stopped" : "completed";
    add({ role: "user", text, at });
  }
}

// What the Codex CLI adds to a user message, not typed by the person: a block that is one tagged element whole
// (<environment_context>…</environment_context>), or a heading over one (an AGENTS.md: "# …" then <INSTRUCTIONS>…</INSTRUCTIONS>);
// and a bare tag alone, as around an image.
const CODEX_CONTEXT = /^\s*(?:#[^\n]*\n\s*)?<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/;
const BARE_TAG = /^\s*<\/?[A-Za-z_][\w-]*(?:\s[^>]*)?>\s*$/;
const typed = (text: string): boolean => !CODEX_CONTEXT.test(text) && !BARE_TAG.test(text);
/** The person's words in a Codex user message or user_message event: "" when the CLI wrote all of it. */
const wordsOf = (content: unknown): string => {
  if (typeof content === "string") return typed(content) ? content : "";
  return textOf(Array.isArray(content) ? content.filter((block) => !isObject(block) || typeof block.text !== "string" || typed(block.text)) : content);
};

function codexRecord(value: Record<string, unknown>, at: number, session: Session, { add, names, provider, turns, codex }: Into): void {
  const payload = isObject(value.payload) ? value.payload : {};
  if (value.type === "session_meta") {
    if (str(payload.id)) session.id = payload.id as string;
    if (str(payload.cwd)) session.cwd = payload.cwd as string;
    if (str(payload.model_provider)) provider.name = payload.model_provider as string;
    if (str(payload.parent_thread_id) || (isObject(payload.source) && isObject(payload.source.subagent))) session.child = true;
    return;
  }
  if (value.type === "turn_context") {
    const model = str(payload.model);
    if (model) session.model = model.includes("/") ? model : `${provider.name ?? "openai"}/${model}`;
    if (!session.cwd && str(payload.cwd)) session.cwd = payload.cwd as string;
    return;
  }
  if (value.type === "event_msg") {
    if (payload.type === "user_message") {
      codex.events = true;
      const text = wordsOf(payload.message);
      if (text) add({ role: "user", text, at });
    } else if (payload.type === "task_complete") session.state = "completed";
    else if (payload.type === "turn_aborted") session.state = "stopped";
    else if (payload.type === "error") session.state = "failed";
    return;
  }
  if (value.type !== "response_item") return;
  if (payload.type === "message" && payload.role === "user") {
    const text = wordsOf(payload.content);
    if (text) codex.held.push({ index: turns.length, turn: { role: "user", text, at } });
  } else if (payload.type === "message" && payload.role === "assistant") {
    const text = textOf(payload.content);
    if (text) add({ role: "assistant", text, calls: [], at });
  } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const id = String(payload.call_id ?? payload.id ?? "");
    const name = String(payload.name ?? "");
    names.set(id, name);
    add({
      role: "assistant",
      text: "",
      calls: [
        {
          type: "toolCall",
          id,
          name,
          arguments: argsOf(payload.type === "function_call" ? payload.arguments : payload.input),
        },
      ],
      at,
    });
  } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const id = String(payload.call_id ?? "");
    const output = isObject(payload.output) && "content" in payload.output ? payload.output.content : payload.output;
    add({
      role: "toolResult",
      callId: id,
      name: names.get(id) ?? "",
      text: textOf(output),
      isError: false,
      at,
    });
  }
}

function piRecord(value: Record<string, unknown>, at: number, session: Session, { add, priced }: Into): void {
  if (value.type === "session") {
    if (str(value.id)) session.id = value.id as string;
    if (str(value.cwd)) session.cwd = value.cwd as string;
    return;
  }
  if (value.type === "model_change") {
    if (str(value.provider) && str(value.modelId)) session.model = `${value.provider}/${value.modelId}`;
    return;
  }
  if (value.type !== "message" || !isObject(value.message)) return;
  const message = value.message;
  const when = timeOf(message.timestamp) ?? at;
  if (message.role === "user") add({ role: "user", text: textOf(message.content), at: when });
  else if (message.role === "toolResult")
    add({
      role: "toolResult",
      callId: String(message.toolCallId ?? ""),
      name: String(message.toolName ?? ""),
      text: textOf(message.content),
      isError: message.isError === true,
      at: when,
    });
  else if (message.role === "assistant") {
    if (str(message.provider) && str(message.model)) session.model = `${message.provider}/${message.model}`;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((b) => isObject(b) && b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const calls: ToolCall[] = blocks
      .filter((b): b is Record<string, unknown> => isObject(b) && b.type === "toolCall")
      .map((b) => ({
        type: "toolCall",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        arguments: argsOf(b.arguments),
      }));
    const usage = isObject(message.usage) && isObject(message.usage.cost) ? message.usage.cost : undefined;
    const cost = typeof usage?.total === "number" && Number.isFinite(usage.total) && usage.total >= 0 ? usage.total : undefined;
    // pi prices each request: the session's cost is their sum, unknown once one is not priced.
    priced.sum += cost ?? 0;
    priced.unknown ||= cost === undefined;
    session.costUsd = priced.unknown ? undefined : priced.sum;
    session.state = message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "stopped" : "completed";
    add({
      role: "assistant",
      text,
      calls,
      at: when,
      ...(cost !== undefined ? { costUsd: cost } : {}),
    });
  }
}
