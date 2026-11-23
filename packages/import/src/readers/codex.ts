// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. A subagent's thread names its parent in its session_meta.
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { type FileCursor, type LineSource, lineReader, type ReadContext } from "../lines.js";
import { entries, type Reader, rememberUser } from "../reader.js";
import { argsOf, effortOf, isObject, str, textOf, timeOf } from "../text.js";
import type { Answer, Turn } from "../types.js";
import { normalizeUsage } from "../usage.js";

/** Whether the file has user_message events, and its user messages, each with its place among the turns, held to the
 *  file's end. `open`: the request the model's output items join, until a result of one of its calls; `unpaid`, the
 *  latest request whose usage has not come (written after its calls' results at times); `records`, whether the file has
 *  token_usage_records, with the responses they counted, and `total`, the last token_count's total; `items`, whether
 *  each completed item failed, and `results`, each tool result by call id, with whether its output said; `provider`, the
 *  model provider its session_meta names; `forkedFrom`, the threads its session_meta says it forked or was spawned from;
 *  `replay`, the parent's history a fork copied in (forkReplay), null when there is none. */
type Own = {
  forkedFrom?: Set<string>;
  replay?: Replay | null;
  events: boolean;
  held: { index: number; turn: Turn }[];
  open?: Answer;
  unpaid?: Answer;
  records: boolean;
  responses: Set<string>;
  total?: string;
  items: Map<string, boolean>;
  results: Map<string, { turn: Extract<Turn, { role: "toolResult" }>; stated: boolean }>;
  provider?: string;
};

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

function readRecord(value: Record<string, unknown>, at: number, { state, keep, add }: ReadContext<Own>): void {
  const { session, names, turns, own: codex } = state;
  const payload = isObject(value.payload) ? value.payload : {};
  // One request's output items are one turn; its usage, when it comes, is that turn's. A usage with no request (a
  // compaction's, one whose output is no item read here) is a turn of its own.
  const answer = (): Answer => {
    const turn: Answer = { role: "assistant", text: "", calls: [], at, ...(session.model ? { model: session.model } : {}), ...(state.effort ? { effort: state.effort } : {}) };
    add(turn);
    return turn;
  };
  const request = (): Answer => codex.open ?? (codex.open = codex.unpaid = answer());
  // Each request's own counts (a token_count's last_token_usage), never the thread's running total.
  const answered = (usage: unknown, response?: string) => {
    const tokens = normalizeUsage("openai", usage);
    const turn = codex.unpaid ?? answer();
    if (tokens) turn.usage = tokens;
    if (response) turn.key = response;
    codex.open = codex.unpaid = undefined;
  };
  if (value.type === "session_meta") {
    // A fork writes its parent's session_meta after its own (Codex 0.154): one whose id is the thread this rollout forked
    // from is that copy, and says nothing of this rollout. Any other later session_meta still counts, as Codex writes it.
    const id = str(payload.id);
    if (id && codex.forkedFrom?.has(id)) return;
    const spawn = isObject(payload.source) && isObject(payload.source.subagent) && isObject(payload.source.subagent.thread_spawn) ? payload.source.subagent.thread_spawn : undefined;
    const parent = str(payload.parent_thread_id) ?? str(spawn?.parent_thread_id);
    for (const from of [str(payload.forked_from_id), parent]) if (from && from !== id) (codex.forkedFrom ??= new Set()).add(from);
    if (id) session.id = id;
    if (str(payload.cwd)) session.cwd = payload.cwd as string;
    if (str(payload.model_provider)) codex.provider = payload.model_provider as string;
    if (str(payload.parent_thread_id) || (isObject(payload.source) && isObject(payload.source.subagent))) session.child = true;
    if (parent) session.parent = parent;
    return;
  }
  if (value.type === "turn_context") {
    const model = str(payload.model);
    if (model) session.model = model.includes("/") ? model : `${codex.provider ?? "openai"}/${model}`;
    if (!session.cwd && str(payload.cwd)) session.cwd = payload.cwd as string;
    state.effort = effortOf(payload.effort);
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
    return answered(payload.usage, id);
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
      if (keep) turn.text = [turn.text, text].filter(Boolean).join("\n");
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
      arguments: keep ? argsOf(payload.type === "function_call" ? payload.arguments : payload.input) : {},
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
      // Without turns, no output text: the result is kept for whether it failed, in the result and the cursor alike.
      text: keep ? textOf(output) : "",
      isError: stated ?? codex.items.get(id) ?? false,
      at,
    };
    codex.results.set(id, { turn, stated: stated !== undefined });
    add(turn);
  }
}

// A forked rollout (session_meta's forked_from_id, or a spawned subagent's thread_spawn parent) can begin with a copy of
// its parent's history, token_counts and all, written at the fork's time: Codex 0.130 and 0.145 do. Those requests are
// the parent's, counted where the parent's rollout is read; read again here they would count twice. Which of the fork's
// leading usages are copies is ccusage's rule (MIT; ryoppippi/ccusage rust/adapters/codex/src/parser/replay_filter.rs,
// replay.rs, README.md "Forked rollouts"), ported here, its code not copied:
// - The window: the fork's usages up to its own boundary, the first token_usage_record or thread_settings_applied that
//   names the fork's own thread (Codex 0.152 stamps them); a spawned subagent's first record naming no thread ends it
//   too, as spawned subagents never copy the parent's records. No boundary: the whole rollout.
// - The window's leading usages are matched against the parent's usages from before the fork's time: the longest run
//   equal to that stream's start, or to its end (the history a parent kept after it compacted), is copied.
// - Usage between the first marker naming another thread and the boundary is copied as well.
// - A parent whose rollout is not under the home has nothing to match: the usages count (ccusage warns and counts).
// A usage is a token_count whose total moved, by its last_token_usage; records with a response id are never copies here.

/** A fork's copy (forkReplay): the usages to skip, by ordinal, the last of them, the usages read so far, and the total
 *  the last skipped one left; `open`, whether the file ended before its copy's end could be known, so a read of more of it
 *  finds the copy again (codex.read). */
type Replay = { skip: [number, number][]; until: number; seen: number; total?: string; open: boolean };

const usageFields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

/** A token_count's usage as a key, when the count is a usage (its total moved from `last.total`, which it moves on), else
 *  undefined. Two requests with the same counts are the same key: as ccusage compares them. */
function usageOf(value: Record<string, unknown>, last: { total?: string }): string | undefined {
  const payload = isObject(value.payload) ? value.payload : undefined;
  if (value.type !== "event_msg" || payload?.type !== "token_count" || !isObject(payload.info)) return undefined;
  const { info } = payload;
  const total = isObject(info.total_token_usage) ? JSON.stringify(info.total_token_usage) : undefined;
  if (total !== undefined && total === last.total) return undefined;
  last.total = total;
  const use = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
  const counts = usageFields.map((field) => {
    const n = use?.[field];
    return typeof n === "number" ? n : 0;
  });
  // No usage when every count but the total is 0, as ccusage's CodexRawUsage::is_empty has it: a fork's first
  // token_count can carry only a total_tokens, and that is no request of the parent's to match.
  return counts.slice(0, -1).some((n) => n > 0) ? counts.join(",") : undefined;
}

/** The longest run at the start of `child` equal to the start of `parent`, or to its end. */
function copiedLength(parent: string[], child: string[]): number {
  const pattern = child.slice(0, parent.length);
  let prefix = 0;
  while (prefix < pattern.length && pattern[prefix] === parent[prefix]) prefix += 1;
  if (!pattern.length) return 0;
  // The longest start of `pattern` that `parent` ends with: a prefix function over it, run along the parent's end.
  const fail = new Array<number>(pattern.length).fill(0);
  for (let i = 1, k = 0; i < pattern.length; i += 1) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1]!;
    if (pattern[i] === pattern[k]) k += 1;
    fail[i] = k;
  }
  let matched = 0;
  for (const use of parent.slice(parent.length - pattern.length)) {
    while (matched > 0 && use !== pattern[matched]) matched = fail[matched - 1]!;
    if (use === pattern[matched]) matched += 1;
    if (matched === pattern.length) break;
  }
  return Math.max(prefix, matched);
}

/** A rollout's lines, parsed, each record that is a JSON object. Its file is closed however the reading stops. */
async function* recordsOf(file: string): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(file, { highWaterMark: 1 << 20 });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(value)) yield value;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** A rollout's first line as a JSON object, read alone (up to 16 MiB), so a rollout that is no fork is not streamed for
 *  it. */
async function firstRecord(file: string): Promise<Record<string, unknown> | undefined> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < 16 * 1024 * 1024; ) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const end = chunk.subarray(0, bytesRead).indexOf(10);
      chunks.push(chunk.subarray(0, end === -1 ? bytesRead : end));
      if (end !== -1) break;
      position += bytesRead;
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** The parent's usages, each with its time, as its rollout holds them: the last few read kept, as a parent's forks are
 *  read one after another. */
const parentUsages = new Map<string, { mark: string; uses: string[]; ats: (number | undefined)[] }>();
async function usagesOf(file: string): Promise<{ uses: string[]; ats: (number | undefined)[] }> {
  const stats = await stat(file);
  const mark = `${stats.size}:${stats.mtimeMs}`;
  const kept = parentUsages.get(file);
  if (kept?.mark === mark) return kept;
  const out = { mark, uses: [] as string[], ats: [] as (number | undefined)[] };
  const last: { total?: string } = {};
  for await (const value of recordsOf(file)) {
    const use = usageOf(value, last);
    if (use === undefined) continue;
    out.uses.push(use);
    out.ats.push(timeOf(value.timestamp));
  }
  parentUsages.delete(file);
  parentUsages.set(file, out);
  if (parentUsages.size > 4) parentUsages.delete(parentUsages.keys().next().value!);
  return out;
}

/** Every rollout under a sessions directory by the thread id its name ends with, in the order a walk of its
 *  year/month/day directories meets them. */
async function rolloutsUnder(sessions: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const year of await entries(sessions)) {
    if (!year.isDirectory()) continue;
    for (const month of await entries(join(sessions, year.name))) {
      if (!month.isDirectory()) continue;
      for (const day of await entries(join(sessions, year.name, month.name))) {
        if (!day.isDirectory()) continue;
        const dir = join(sessions, year.name, month.name, day.name);
        for (const entry of await entries(dir)) {
          const id = entry.isFile() && entry.name.startsWith("rollout-") ? /-([0-9a-f-]{36})\.jsonl$/i.exec(entry.name)?.[1] : undefined;
          if (id) (out.get(id) ?? out.set(id, []).get(id)!).push(join(dir, entry.name));
        }
      }
    }
  }
  return out;
}

/** The parent's rollout: in the sessions directory `file` is under, named by the parent's id, on its UUIDv7 date (a
 *  day either side, as the directories are local dates) else anywhere there. Anywhere is one walk of the directory per
 *  import (`lookups`), however many forks look there, found or not. Not archived_sessions: the import reads no rollout
 *  there, and a copy of a parent it does not read is the only count of that history. */
async function parentFile(file: string, parent: string, lookups?: Map<string, unknown>): Promise<string | undefined> {
  const sessions = dirname(dirname(dirname(dirname(file))));
  const ms = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(parent) ? Number.parseInt(parent.replace(/-/g, "").slice(0, 12), 16) : Number.NaN;
  if (Number.isFinite(ms)) {
    for (const shift of [0, -1, 1]) {
      const dir = join(sessions, ...new Date(ms + shift * 86_400_000).toISOString().slice(0, 10).split("-"));
      const name = (await entries(dir)).find((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${parent}.jsonl`) && join(dir, entry.name) !== file)?.name;
      if (name) return join(dir, name);
    }
  }
  const key = `codex:rollouts:${sessions}`;
  let index = lookups?.get(key) as Promise<Map<string, string[]>> | undefined;
  if (!index) {
    index = rolloutsUnder(sessions);
    lookups?.set(key, index);
  }
  return (await index).get(parent)?.find((path) => path !== file);
}

/** The parent's history `file` copied in, when it is a fork that did: read before the fork's own lines, so its records
 *  read as copies (record). */
async function forkReplay(file: string, lookups?: Map<string, unknown>): Promise<Replay | null> {
  const first = await firstRecord(file);
  const payload = isObject(first?.payload) ? first.payload : undefined;
  if (first?.type !== "session_meta" || !payload) return null;
  const own = str(payload.id)?.trim() || undefined;
  const spawn = isObject(payload.source) && isObject(payload.source.subagent) && isObject(payload.source.subagent.thread_spawn) ? payload.source.subagent.thread_spawn : undefined;
  const spawnedBy = str(spawn?.parent_thread_id);
  const parent = str(payload.forked_from_id) ?? spawnedBy;
  // A rollout that names its history's base reads it by reference, copying none; one named <thread>_<rollout> whose
  // id is the thread goes on with that thread, as no fork.
  if (!parent || payload.history_base !== undefined) return null;
  const named = /-([0-9a-f-]{36})_([0-9a-f-]{36})\.jsonl$/i.exec(basename(file));
  if (named && named[1] !== named[2] && own === named[1]) return null;
  const records = recordsOf(file);
  try {
    await records.next();
    const forkedAt = timeOf(first.timestamp);
    let stream: string[] | undefined;
    const parentStream = async () => {
      if (stream) return stream;
      const path = await parentFile(file, parent, lookups);
      if (!path) return (stream = []);
      const { uses, ats } = await usagesOf(path);
      const cut = forkedAt === undefined ? -1 : ats.findIndex((t) => t !== undefined && t > forkedAt);
      return (stream = cut === -1 ? uses : uses.slice(0, cut));
    };
    const uses: string[] = [];
    const last: { total?: string } = {};
    let foreign: number | undefined;
    let boundary: number | undefined;
    let marked = false;
    // Whether the read reached the file's end with the copy's end unknown: no own marker, and the run could still grow.
    let ended = true;
    // Whether the usages so far are the parent's first ones, and where in the parent's they could start a run that ends
    // at its end: while either holds the copied run can grow, so the read goes on.
    let prefix = true;
    let starts: number[] = [];
    const grows = (parentUses: string[], use: string): boolean => {
      const i = uses.length - 1;
      prefix &&= parentUses[i] === use;
      starts = i === 0 ? parentUses.flatMap((u, j) => (u === use ? [j] : [])) : starts.filter((j) => j + i < parentUses.length && parentUses[j + i] === use);
      return uses.length < parentUses.length && (prefix || starts.length > 0);
    };
    for await (const value of records) {
      const p = isObject(value.payload) ? value.payload : undefined;
      const marker = value.type === "token_usage_record" ? "record" : value.type === "event_msg" && p?.type === "thread_settings_applied" ? "settings" : undefined;
      if (marker) {
        const thread = str(p?.thread_id)?.trim() || undefined;
        if (thread) marked = true;
        if (thread && thread === own) {
          boundary = uses.length;
          ended = false;
          break;
        }
        if (marker === "record" && !thread && spawnedBy) {
          ended = false;
          break;
        }
        if (thread && own) foreign ??= uses.length;
        continue;
      }
      const use = usageOf(value, last);
      if (use === undefined) continue;
      uses.push(use);
      // Read on only while the copied run can still grow, or while a thread's marker may yet bound one.
      if (!grows(await parentStream(), use) && !marked) {
        ended = false;
        break;
      }
    }
    const window = uses.slice(0, boundary ?? uses.length);
    const skip: [number, number][] = [];
    if (window.length) {
      const copied = copiedLength(await parentStream(), window);
      if (copied) skip.push([0, copied]);
    }
    if (foreign !== undefined && boundary !== undefined && boundary > foreign) skip.push([foreign, boundary]);
    if (!skip.length && !ended) return null;
    return { skip, until: skip.length ? Math.max(...skip.map(([, to]) => to)) - 1 : -1, seen: 0, open: ended };
  } finally {
    await records.return(undefined);
  }
}

/** One record: a fork's copy of its parent's history is read as a copy (forkReplay); a turn_context in it still sets
 *  the model and effort, and a usage in it that is no copy counts. */
function record(value: Record<string, unknown>, at: number, context: ReadContext<Own>): boolean | void {
  const { own } = context.state;
  const replay = own.replay;
  if (!replay || replay.seen > replay.until || value.type === "session_meta") return readRecord(value, at, context);
  const use = usageOf(value, replay);
  if (use !== undefined) {
    const ordinal = replay.seen;
    replay.seen += 1;
    if (!replay.skip.some(([from, to]) => ordinal >= from && ordinal < to)) return readRecord(value, at, context);
    own.total = replay.total;
    own.open = own.unpaid = undefined;
    return false;
  }
  if (value.type === "turn_context") readRecord(value, at, context);
  else if (value.type === "token_usage_record") own.records = true;
  own.open = own.unpaid = undefined;
  return false;
}

const spec: LineSource<"codex", Own> = {
  source: "codex",
  name: "Codex",
  harness: "codex",
  async files(home, env) {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await entries(dir)) {
        if (entry.isDirectory() && depth < 3) await walk(join(dir, entry.name), depth + 1);
        else if (entry.isFile() && depth === 3 && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(join(dir, entry.name));
      }
    };
    // CODEX_HOME where the environment names it, else ~/.codex.
    await walk(join(env?.CODEX_HOME || join(home, ".codex"), "sessions"), 0);
    return out;
  },
  start: () => ({ events: false, held: [], records: false, responses: new Set(), items: new Map(), results: new Map() }),
  record,
  // Older Codex writes each of the person's turns twice, as a user_message event and as a user message; current Codex
  // writes the user message alone. One source per file, so no turn counts twice.
  finish(out, turns, { state: { own }, keep }) {
    if (own.events || !own.held.length) return turns;
    // Held indexes refer to the non-user turns as read. Merge both ordered lists once: inserting each user into the middle
    // of the transcript shifts its remaining turns again and again on a long current-Codex session.
    const ordered: Turn[] = [];
    let next = 0;
    for (const { index, turn } of own.held) {
      rememberUser(out, turn);
      if (keep) {
        while (next < index) ordered.push(turns[next++]!);
        ordered.push(turn);
      }
    }
    if (!keep) return turns;
    while (next < turns.length) ordered.push(turns[next++]!);
    return ordered;
  },
  idOf: (file) => basename(file, ".jsonl"),
  // A turns: false cursor keeps each held prompt for its count alone: a read resumed from it gives no first prompt.
  forget: (own) => ({ ...own, held: own.held.map(({ index, turn }) => ({ index, turn: { ...turn, text: "" } as Turn })) }),
};

const lines = lineReader(spec);

/** Codex's reader: a read from a rollout's start first finds the parent's history a fork copied in (forkReplay); a read
 *  going on from a cursor has it in the cursor's state. A fork whose copy was still open where the last read ended, and
 *  that has grown since, is read again from its start, as is a rollout the line reader starts over (rewritten in place). */
export const codex: Reader<"codex", FileCursor> = {
  ...lines,
  async read(locator, cursor, options) {
    const fresh = async () => {
      const replay = await forkReplay(locator.file, options?.lookups);
      return replay ? lineReader({ ...spec, start: () => ({ ...spec.start(), replay }) }).read(locator, undefined, options) : undefined;
    };
    if (!cursor) return (await fresh()) ?? lines.read(locator, undefined, options);
    const copyOpen = (cursor.state as { own?: Own }).own?.replay?.open === true;
    if (copyOpen && (await stat(locator.file)).size > cursor.offset) return (await fresh()) ?? lines.read(locator, undefined, options);
    const result = await lines.read(locator, cursor, options);
    return result.resumed ? result : ((await fresh()) ?? result);
  },
};
