// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. A subagent's thread names its parent in its session_meta.
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { type LineSource, lineReader, type ReadContext } from "../lines.js";
import { entries, type Locator, rememberUser } from "../reader.js";
import { argsOf, effortOf, isObject, str, textOf } from "../text.js";
import type { Answer, Turn } from "../types.js";
import { normalizeUsage } from "../usage.js";

/** Whether the file has user_message events, and its user messages, each with its place among the turns, held to the
 *  file's end. `open`: the request the model's output items join, until a result of one of its calls; `unpaid`, the
 *  latest request whose usage has not come (written after its calls' results at times); `records`, whether the file has
 *  token_usage_records, with the responses they counted, and `total`, the last token_count's total; `items`, whether
 *  each completed item failed, and `results`, each tool result by call id, with whether its output said; `provider`, the
 *  model provider its session_meta names. */
type Own = {
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

function record(value: Record<string, unknown>, at: number, { state, keep, add }: ReadContext<Own>): void {
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
    if (str(payload.id)) session.id = payload.id as string;
    if (str(payload.cwd)) session.cwd = payload.cwd as string;
    if (str(payload.model_provider)) codex.provider = payload.model_provider as string;
    if (str(payload.parent_thread_id) || (isObject(payload.source) && isObject(payload.source.subagent))) session.child = true;
    const parent = parentIn(payload);
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

/** The thread a session_meta payload names as the one it ran under. */
function parentIn(payload: Record<string, unknown>): string | undefined {
  const spawn = isObject(payload.source) && isObject(payload.source.subagent) && isObject(payload.source.subagent.thread_spawn) ? payload.source.subagent.thread_spawn : undefined;
  return str(payload.parent_thread_id) ?? str(spawn?.parent_thread_id);
}

/** How much of a rollout's start parentOf reads: its first line, session_meta, holds the instructions the thread ran
 *  with (some 20 KB), and must end within it. */
const HEAD_BYTES = 256 * 1024;

/** The thread a rollout ran under, from its first line alone (session_meta), never reading past HEAD_BYTES: what ties a
 *  file no one reads whole (over a caller's cap) to its parent. None when that line does not end within it. */
async function parentOf({ file }: Locator): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    // A line cut short by the bound parses as nothing.
    const end = head.subarray(0, bytesRead).indexOf(10);
    const value: unknown = JSON.parse(head.subarray(0, end < 0 ? bytesRead : end).toString("utf8"));
    return isObject(value) && value.type === "session_meta" && isObject(value.payload) ? parentIn(value.payload) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export const codex = { ...lineReader(spec), parentOf };
