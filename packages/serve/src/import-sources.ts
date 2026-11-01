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
/** A request's tokens as pi counts them: `input` is the input neither read from nor written to the cache;
 *  `cacheWrite1h`, the part of `cacheWrite` kept for an hour, which Anthropic prices higher. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number };
/** An assistant turn is one model request: `model` the one it ran on ("provider/model"), `effort` the effort or
 *  thinking level it ran at, `usage` its tokens, each absent when the source does not say; `error`, why it failed. A
 *  note is a line the harness itself wrote in the conversation: no request, nor the person's. */
export type Turn =
  | { role: "user"; text: string; at: number }
  | { role: "note"; author: string; text: string; at: number }
  | {
      role: "assistant";
      text: string;
      calls: ToolCall[];
      at: number;
      costUsd?: number;
      key?: string;
      model?: string;
      effort?: string;
      usage?: Usage;
      error?: string;
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
type Answer = Extract<Turn, { role: "assistant" }>;

/** The longest gap between two records counted as time at work: Claude Code's Bash tool runs a call for up to 10
 *  minutes with nothing written, and a longer gap is a session left open. */
export const ACTIVE_GAP_MS = 15 * 60_000;

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
  /** Time at work: the gaps between its records, each at most ACTIVE_GAP_MS. */
  activeMs: number;
  /** The effort or thinking level most of its requests ran at, as the source names it; with its turns only. */
  effort?: string;
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
/** A usage's counts under the source's names for input, cache read, cache write and output; undefined unless input and
 *  output are counts (an absent cache count is 0). `cachedIn`: the source's input holds its cache reads and writes. */
const tokensOf = (usage: unknown, [input, cacheRead, cacheWrite, output]: readonly string[], cachedIn = false): Usage | undefined => {
  if (!isObject(usage)) return undefined;
  const count = (key: string, absent?: number) => {
    const value = usage[key] ?? absent;
    return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
  };
  const counts = { input: count(input!), output: count(output!), cacheRead: count(cacheRead!, 0), cacheWrite: count(cacheWrite!, 0) };
  if (counts.input === undefined || counts.output === undefined || counts.cacheRead === undefined || counts.cacheWrite === undefined) return undefined;
  if (cachedIn) counts.input -= counts.cacheRead + counts.cacheWrite;
  return counts.input >= 0 ? (counts as Usage) : undefined;
};
/** `usage` with the part of its cache writes kept for an hour, when `long` is a count of at most its writes. */
const withLong = (usage: Usage | undefined, long: unknown): Usage | undefined =>
  usage && Number.isSafeInteger(long) && (long as number) >= 0 && (long as number) <= usage.cacheWrite ? { ...usage, cacheWrite1h: long as number } : usage;
/** The most of each count of two records of one request. */
const most = (a: Usage, b: Usage): Usage => {
  const long = Math.max(a.cacheWrite1h ?? -1, b.cacheWrite1h ?? -1);
  return { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite), ...(long >= 0 ? { cacheWrite1h: long } : {}) };
};
const CLAUDE_TOKENS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];
// OpenAI's input_tokens holds the cached tokens, and its output_tokens the reasoning.
const CODEX_TOKENS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];
const PI_TOKENS = ["input", "cacheRead", "cacheWrite", "output"];
const effortOf = (value: unknown): string | undefined => (typeof value === "string" && /^[\w-]{1,32}$/.test(value) ? value : undefined);

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
    activeMs: 0,
  };
  const turns: Turn[] = [];
  let first: number | undefined;
  let last: number | undefined;
  const names = new Map<string, string>();
  const priced = { sum: 0, unknown: false };
  const provider: { name?: string } = {};
  const current: Into["current"] = { keyed: new Map(), seen: new Set() };
  const codex: Into["codex"] = { events: false, held: [], records: false, responses: new Set(), items: new Map(), results: new Map() };
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
      if (last !== undefined) session.activeMs += Math.min(Math.max(0, at - last), ACTIVE_GAP_MS);
      last = at;
    }
    record(value, at ?? last ?? 0, session, { add, names, turns, priced, provider, current, codex });
  }
  // Older Codex writes each of the person's turns twice, as a user_message event and as a user message; current Codex
  // writes the user message alone. One source per file, so no turn counts twice.
  if (!codex.events) codex.held.forEach(({ index, turn }, k) => add(turn, index + k));
  if (!session.id) session.id = source === "pi" ? basename(file, ".jsonl").split("_").pop()! : basename(file, ".jsonl");
  if (first !== undefined) session.startedAt = new Date(first).toISOString();
  if (last !== undefined) session.endedAt = new Date(last).toISOString();
  session.activeMs = Math.round(session.activeMs);
  session.turns = turns;
  // As the model of most requests is a run's model: the first seen of a tie.
  const efforts = new Map<string, number>();
  for (const turn of turns) if (turn.role === "assistant" && turn.effort) efforts.set(turn.effort, (efforts.get(turn.effort) ?? 0) + 1);
  for (const [effort, n] of efforts) if (session.effort === undefined || n > efforts.get(session.effort)!) session.effort = effort;
  return session;
}

type Into = {
  add: (turn: Turn) => void;
  names: Map<string, string>;
  turns: Turn[];
  priced: { sum: number; unknown: boolean };
  /** Codex's model provider, from its session_meta, for the model its turns name. */
  provider: { name?: string };
  /** The effort in force (Codex's turn_context, pi's thinking level); Claude Code's turns by message id, and the
   *  records read, by uuid. */
  current: { effort?: string; keyed: Map<string, Answer>; seen: Set<string> };
  /** Codex: whether the file has user_message events, and its user messages, each with its place among the turns, held
   *  to the file's end. `open`: the request the model's output items join, until a result of one of its calls; `unpaid`,
   *  the latest request whose usage has not come (written after its calls' results at times); `records`, whether the
   *  file has token_usage_records, with the responses they counted, and `total`, the last token_count's total; `items`,
   *  whether each completed item failed, and `results`, each tool result by call id, with whether its output said. */
  codex: {
    events: boolean;
    held: { index: number; turn: Turn }[];
    open?: Answer;
    unpaid?: Answer;
    records: boolean;
    responses: Set<string>;
    total?: string;
    items: Map<string, boolean>;
    results: Map<string, { turn: Extract<Turn, { role: "toolResult" }>; stated: boolean }>;
  };
};

const INTERRUPTED = /^\[Request interrupted by user/;

function claudeRecord(value: Record<string, unknown>, at: number, session: Session, { add, names, current }: Into): void {
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
  // A record written twice (a session carried on in its own file) is read once.
  const uuid = str(value.uuid);
  if (uuid && current.seen.has(uuid)) return;
  if (uuid) current.seen.add(uuid);
  const message = value.message;
  if (value.type === "assistant") {
    const model = str(message.model);
    const synthetic = model === "<synthetic>";
    if (model && !synthetic) session.model = `anthropic/${model}`;
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
    // The CLI's own turns (model <synthetic>): one marked an API error is a request that failed; any other ("No response
    // requested.") is no request, kept as the CLI's note.
    const failed = value.isApiErrorMessage === true;
    if (synthetic && !failed) {
      if (text) add({ role: "note", author: "Claude Code", text, at });
      return;
    }
    session.state = failed ? "failed" : "completed";
    // One request's blocks come as records of one message id, a parallel call's result between two of them: one turn.
    // Each record repeats the request's usage, the final one the most of each count (an earlier record may hold only the
    // stream's start).
    const key = str(message.id);
    const usage = withLong(tokensOf(message.usage, CLAUDE_TOKENS), isObject(message.usage) && isObject(message.usage.cache_creation) ? message.usage.cache_creation.ephemeral_1h_input_tokens : undefined);
    const held = key ? current.keyed.get(key) : undefined;
    if (held) {
      held.text = [held.text, text].filter(Boolean).join("\n");
      held.calls.push(...calls);
      if (usage) held.usage = held.usage ? most(held.usage, usage) : usage;
      return;
    }
    if (!key && !text && calls.length === 0) return;
    const effort = effortOf(value.perTurnEffort) ?? effortOf(value.effort);
    const turn: Answer = { role: "assistant", text, calls, at, ...(key ? { key } : {}), ...(session.model ? { model: session.model } : {}), ...(effort ? { effort } : {}), ...(usage ? { usage } : {}), ...(failed ? { error: text || "API error" } : {}) };
    if (key) current.keyed.set(key, turn);
    add(turn);
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

// The blocks the Codex CLI adds to a user message, each one of its own elements whole, an AGENTS.md as a heading over its
// <INSTRUCTIONS>; and the bare tags around an image. Only these: a prompt the person wrote as a tagged element is theirs,
// and a block the CLI adds later reads as text until it is named here.
const CODEX_BLOCK = /^\s*(?:#[^\n]*\n\s*)?<([A-Za-z_]+)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/;
const CODEX_BLOCKS = new Set(["environment_context", "user_instructions", "INSTRUCTIONS", "turn_aborted", "subagent_notification", "skill", "user_shell_command", "user_action", "recommended_plugins", "codex_internal_context"]);
const IMAGE_TAG = /^\s*<\/?image\b[^>]*>\s*$/;
const typed = (text: string): boolean => !CODEX_BLOCKS.has(CODEX_BLOCK.exec(text)?.[1] ?? "") && !IMAGE_TAG.test(text);
/** The person's words in a Codex user message: "" when the CLI wrote all of it. */
const wordsOf = (content: unknown): string => textOf(Array.isArray(content) ? content.filter((block) => !isObject(block) || typeof block.text !== "string" || typed(block.text)) : content);

// The response items of the model's own output: each of one request, until its usage comes.
const CODEX_OUTPUTS = new Set(["reasoning", "function_call", "custom_tool_call", "web_search_call", "tool_search_call"]);
const CODEX_HEAD = /^(?:Command|Chunk ID|Exit code): /;
const CODEX_EXIT = /^(?:Exit code: |Process exited with code )(-?\d+)$/;
/** Whether a Codex tool call failed, as its output says, else undefined: a structured output's success flag or
 *  metadata.exit_code, the exit code in a shell call's head (the lines before "Output:"), or how a script ended. */
function codexFailed(output: unknown): boolean | undefined {
  if (isObject(output) && typeof output.success === "boolean") return !output.success;
  const text = textOf(isObject(output) && "content" in output ? output.content : output);
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isObject(parsed) && isObject(parsed.metadata) && typeof parsed.metadata.exit_code === "number") return parsed.metadata.exit_code !== 0;
    } catch {
      // Not JSON: read as text.
    }
  }
  const lines = text.split("\n", 64);
  if (/^Script failed\b/.test(lines[0]!)) return true;
  if (/^Script completed\b/.test(lines[0]!)) return false;
  if (!CODEX_HEAD.test(lines[0]!)) return undefined;
  for (const line of lines) {
    if (line === "Output:") break;
    const code = CODEX_EXIT.exec(line)?.[1];
    if (code !== undefined) return code !== "0";
  }
  return undefined;
}

function codexRecord(value: Record<string, unknown>, at: number, session: Session, { add, names, provider, turns, current, codex }: Into): void {
  const payload = isObject(value.payload) ? value.payload : {};
  // One request's output items are one turn; its usage, when it comes, is that turn's. A usage with no request (a
  // compaction's, one whose output is no item read here) is a turn of its own.
  const answer = (): Answer => {
    const turn: Answer = { role: "assistant", text: "", calls: [], at, ...(session.model ? { model: session.model } : {}), ...(current.effort ? { effort: current.effort } : {}) };
    add(turn);
    return turn;
  };
  const request = (): Answer => codex.open ?? (codex.open = codex.unpaid = answer());
  const answered = (usage: unknown) => {
    const tokens = tokensOf(usage, CODEX_TOKENS, true);
    const turn = codex.unpaid ?? answer();
    if (tokens) turn.usage = tokens;
    codex.open = codex.unpaid = undefined;
  };
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
    current.effort = effortOf(payload.effort);
    // A new turn: a request left open (aborted) has no usage to come.
    codex.open = codex.unpaid = undefined;
    return;
  }
  // Each request's usage: a token_usage_record per response where the rollout has them (they also count requests no
  // token_count reports, such as a compaction's), else each token_count whose total moved (one that repeats the last
  // total is no new request).
  if (value.type === "token_usage_record") {
    codex.records = true;
    const id = str(payload.response_id);
    if (id && codex.responses.has(id)) return;
    if (id) codex.responses.add(id);
    return answered(payload.usage);
  }
  if (value.type === "event_msg") {
    if (payload.type === "user_message") {
      codex.events = true;
      if (str(payload.message)) add({ role: "user", text: payload.message as string, at });
    } else if (payload.type === "token_count") {
      const info = isObject(payload.info) ? payload.info : undefined;
      if (!info || codex.records) return;
      const total = isObject(info.total_token_usage) ? JSON.stringify(info.total_token_usage) : undefined;
      if (total !== undefined && total === codex.total) return;
      codex.total = total;
      answered(info.last_token_usage);
    } else if (payload.type === "item_completed" && isObject(payload.item) && str(payload.item.id)) {
      // An item's id is its call's in some Codex versions: its status then says whether the call failed.
      const { id, status, exit_code: code } = payload.item;
      const failed = status === "failed" || (typeof code === "number" && code !== 0) ? true : status === "completed" ? false : undefined;
      if (failed === undefined) return;
      codex.items.set(id as string, failed);
      const result = codex.results.get(id as string);
      if (result && !result.stated) result.turn.isError = failed;
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
    if (text) {
      const turn = request();
      turn.text = [turn.text, text].filter(Boolean).join("\n");
    }
  } else if (typeof payload.type === "string" && CODEX_OUTPUTS.has(payload.type)) {
    const turn = request();
    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
    const id = String(payload.call_id ?? payload.id ?? "");
    const name = String(payload.name ?? "");
    names.set(id, name);
    turn.calls.push({
      type: "toolCall",
      id,
      name,
      arguments: argsOf(payload.type === "function_call" ? payload.arguments : payload.input),
    });
  } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const id = String(payload.call_id ?? "");
    const output = isObject(payload.output) && "content" in payload.output ? payload.output.content : payload.output;
    const stated = codexFailed(payload.output);
    // The model saw a result: what it writes next is another request.
    if (codex.open?.calls.some((call) => call.id === id)) codex.open = undefined;
    const turn = {
      role: "toolResult" as const,
      callId: id,
      name: names.get(id) ?? "",
      text: textOf(output),
      isError: stated ?? codex.items.get(id) ?? false,
      at,
    };
    codex.results.set(id, { turn, stated: stated !== undefined });
    add(turn);
  }
}

function piRecord(value: Record<string, unknown>, at: number, session: Session, { add, priced, current }: Into): void {
  if (value.type === "session") {
    if (str(value.id)) session.id = value.id as string;
    if (str(value.cwd)) session.cwd = value.cwd as string;
    return;
  }
  if (value.type === "model_change") {
    if (str(value.provider) && str(value.modelId)) session.model = `${value.provider}/${value.modelId}`;
    return;
  }
  if (value.type === "thinking_level_change") {
    current.effort = effortOf(value.thinkingLevel);
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
    // A request cut before its end has only the start of its counts: unknown, as a live run's.
    const tokens = message.stopReason === "aborted" ? undefined : withLong(tokensOf(message.usage, PI_TOKENS), isObject(message.usage) ? message.usage.cacheWrite1h : undefined);
    add({
      role: "assistant",
      text,
      calls,
      at: when,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(current.effort ? { effort: current.effort } : {}),
      ...(tokens ? { usage: tokens } : {}),
      ...(message.stopReason === "error" ? { error: str(message.errorMessage) ?? "unknown error" } : {}),
    });
  }
}
