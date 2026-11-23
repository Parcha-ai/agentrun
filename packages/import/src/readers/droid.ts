// Factory's Droid CLI: $FACTORY_HOME_OVERRIDE/.factory/sessions/<cwd slug>/<session id>.jsonl (the home without the
// override; some sit in sessions/ itself), with <session id>.settings.json beside each. What it writes, as read
// from the droid 1.17.2 binary on npm (@factory/cli-linux-x64@1.17.2, its strings only; never run) and the readers of
// entireio/cli (cmd/entire/cli/agent/factoryaidroid, 11d8511a, checked against Droid 0.243.0 sessions), ccusage
// (rust/adapters/droid, 87d59913) and tokscale (crates/tokscale-core/src/sessions/droid.rs, b265e836):
//   - The transcript opens with {type: "session_start", id, title, cwd, parent?, callingSessionId?, callingToolUseId?}:
//     `parent` the session it was forked from, `callingSessionId` the session whose Task tool ran it (a Worker). Then
//     {type: "message", id, timestamp, message: {role, content}}, content as Anthropic's blocks, each record once by its
//     `id` (a fork copies its source's records, ids and all); and other records (compaction_state, ...) not read here.
//   - Droid writes no request's tokens. The settings file holds the session's running total, `tokenUsage` {inputTokens,
//     outputTokens, cacheCreationTokens, cacheReadTokens, thinkingTokens}, of its own calls alone (a fork starts at 0; a
//     Worker keeps its own; `inclusiveTokenUsage`, the Workers' with it, is not read), and `model`, the latest model.
//     No dollar cost. inputTokens leaves the cache out; thinkingTokens is a part of outputTokens (entireio's tokens.go:
//     Droid's provider adapters store the provider's output total, reasoning in it), so it is never added to it.
//   - A turn ends with {type: "agent_turn_outcome", turnId, reason}: "completed", "cancelled", "model_rate_limited" and
//     the like (the binary's enum of 19; an unknown one Droid reads as "error"). It names no message and holds no text.
//   - thinkingTokens is a part of outputTokens in the binary itself too: the function that splits a request's usage for
//     its /cost view takes min(thinkingTokens, outputTokens) out of outputTokens.
// So a session's requests are its assistant messages, and its total goes on the last of them (the others 0), or on one
// of its own when the transcript holds none. Its cost is the total at the list price of the model settings.json names
// (the session's latest), else the model that last request ran on; with neither, unknown. A session with no
// settings.json, or one with no tokenUsage, has no counts: unmetered.
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type FileCursor, type LineSource, lineReader, type ReadContext } from "../lines.js";
import { type Env, entries, type Reader } from "../reader.js";
import { argsOf, isObject, str, textOf } from "../text.js";
import type { Answer, Ended, ToolCall, Usage } from "../types.js";
import { normalizeUsage } from "../usage.js";

/** Droid's model id as "provider/model": a BYOK model ("custom:<name>") is custom's, any other its maker's where the id
 *  says, else Factory's. */
const PROVIDERS: [RegExp, string][] = [
  [/^claude-/, "anthropic"],
  [/^(?:gpt-|o\d)/, "openai"],
  [/^gemini-/, "google"],
  [/^grok-/, "xai"],
];
const modelOf = (id: string): string => (id.startsWith("custom:") ? `custom/${id.slice(7)}` : `${PROVIDERS.find(([pattern]) => pattern.test(id))?.[1] ?? "factory"}/${id}`);

/** A Droid session's id: the one its session_start record names (`start`), else its file's name (<id>.jsonl). The one
 *  rule, for the reader and for serve alike. */
export function droidSessionId(file: string, start?: unknown): string {
  return (isObject(start) && start.type === "session_start" ? str(start.id) : undefined) ?? basename(file, ".jsonl");
}

/** Text Droid adds to a user message for the model, never the person's words. */
const REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/** How a turn that ended for `reason` leaves the session: a request the provider refused or never answered failed it
 *  (FAILED_REQUEST, a request of its own), so did Droid's own failures; the person's cancel, rejection or exit stopped it. */
const DONE = new Set(["completed", "spec_handoff"]);
const STOPPED = new Set(["cancelled", "permission_rejected", "process_exit"]);
const FAILED_REQUEST = new Set(["model_usage_exhausted", "model_authentication_failed", "model_request_rejected", "model_provider_unreachable", "model_provider_unavailable", "model_rate_limited", "prompt_rejected"]);
const endOf = (reason: string): Ended => (DONE.has(reason) ? "completed" : STOPPED.has(reason) ? "stopped" : "failed");

function record(value: Record<string, unknown>, at: number, { state, seen, keep, add }: ReadContext<undefined>): boolean | void {
  const { session, names } = state;
  if (value.type === "session_start") {
    if (!session.id) session.id = droidSessionId(session.file, value);
    if (str(value.cwd)) session.cwd = value.cwd as string;
    const title = str(value.sessionTitle) ?? str(value.title);
    if (title) session.sourceTitle = title;
    if (str(value.callingSessionId)) {
      session.child = true;
      session.parent = value.callingSessionId as string;
    }
    return;
  }
  if (value.type === "agent_turn_outcome") {
    const reason = str(value.reason);
    if (!reason) return;
    // A fork's copy of its source's outcome is counted there.
    const turnId = str(value.turnId);
    if (turnId && seen.has(`o:${turnId}`)) return false;
    if (turnId) seen.add(`o:${turnId}`);
    session.state = endOf(reason);
    // A request that failed: the reason as its error with turns, without them a fixed "API error" (no source text).
    if (FAILED_REQUEST.has(reason)) add({ role: "assistant", text: "", calls: [], at, ...(session.model ? { model: session.model } : {}), error: keep ? reason : "API error" });
    return;
  }
  if (value.type !== "message" || !isObject(value.message)) return;
  // A record read already (a fork's copy of its source's, or written twice) is read once.
  const id = str(value.id);
  if (id && seen.has(`u:${id}`)) return false;
  if (id) seen.add(`u:${id}`);
  const { message } = value;
  const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [{ type: "text", text: textOf(message.content) }];
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  if (message.role === "assistant") {
    const calls: ToolCall[] = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: keep ? argsOf(b.input) : {} }));
    for (const call of calls) names.set(call.id, call.name);
    const model = str(message.modelId);
    if (model) session.model = modelOf(model);
    // Without turns, no answer text: the request is kept for its count alone.
    add({ role: "assistant", text: keep ? texts.join("\n") : "", calls, at, ...(id ? { key: id } : {}), ...(model ? { model: modelOf(model) } : {}) });
    return;
  }
  if (message.role !== "user") return;
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const callId = String(block.tool_use_id ?? "");
    add({ role: "toolResult", callId, name: names.get(callId) ?? "", text: textOf(block.content), isError: block.is_error === true, at });
  }
  const said = texts.filter((text) => text.trim() !== "" && !REMINDER.test(text));
  if (said.length) add({ role: "user", text: said.join("\n"), at });
}

/** Droid's own directory: under FACTORY_HOME_OVERRIDE where the environment names it (a home, not the .factory in it),
 *  else under the home. */
const sessionsDir = (home: string, env?: Env): string => join(env?.FACTORY_HOME_OVERRIDE || home, ".factory", "sessions");

const spec: LineSource<"droid", undefined> = {
  source: "droid",
  name: "Droid",
  harness: "pi",
  async files(home, env) {
    const root = sessionsDir(home, env);
    const out: string[] = [];
    const add = (dir: string, name: string) => void (name.endsWith(".jsonl") && out.push(join(dir, name)));
    for (const entry of await entries(root)) {
      if (entry.isFile()) add(root, entry.name);
      else if (entry.isDirectory()) for (const file of await entries(join(root, entry.name))) if (file.isFile()) add(join(root, entry.name), file.name);
    }
    return out;
  },
  // By folder, oldest written first: a fork's copies count in the session it copied them from.
  order: (a, b) => dirname(a.file).localeCompare(dirname(b.file)) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file),
  start: () => undefined,
  record,
  idOf: (file) => droidSessionId(file),
};

/** What the settings file beside `file` holds, read whole: the session's total and its model id (counts and an id, no
 *  text). Nothing when there is none, it is no regular file, or it is not whole JSON (being written). */
async function settingsOf(file: string): Promise<{ usage?: Usage; model?: string; read: number }> {
  const path = `${file.replace(/\.jsonl$/, "")}.settings.json`;
  if (!(await lstat(path).catch(() => null))?.isFile()) return { read: 0 };
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!bytes) return { read: 0 };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { read: bytes.length };
  }
  if (!isObject(value)) return { read: bytes.length };
  const usage = normalizeUsage("droid", value.tokenUsage);
  const model = str(value.model);
  return { ...(usage ? { usage } : {}), ...(model ? { model } : {}), read: bytes.length };
}

const lines = lineReader(spec);
const none = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const droid: Reader<"droid", FileCursor> = {
  ...lines,
  async read(locator, cursor, options) {
    const result = await lines.read(locator, cursor, options);
    const { usage, model, read } = await settingsOf(locator.file);
    const sessions = result.sessions.map(({ locator, session, requests }) => {
      if (model) session.model = modelOf(model);
      if (!usage) return { locator, session, requests };
      // New requests, never the read's own (its state holds them): the total on the last, at the session's model, the
      // others 0.
      const last = requests.at(-1);
      const at = session.endedAt ? Date.parse(session.endedAt) : 0;
      const total = (request?: Answer): Answer => {
        const priced = model ? session.model : (request?.model ?? session.model);
        return { ...(request ?? { role: "assistant", text: "", calls: [], at }), ...(priced ? { model: priced } : {}), usage: { ...usage } };
      };
      const counted: Answer[] = last ? requests.map((request) => (request === last ? total(request) : { ...request, usage: none() })) : [total()];
      const swap = new Map<unknown, Answer>(requests.map((request, i) => [request, counted[i]!]));
      session.turns = session.turns.map((turn) => swap.get(turn) ?? turn);
      if (!last && options?.turns !== false) session.turns.push(counted[0]!);
      return { locator, session, requests: counted };
    });
    return { ...result, sessions, read: result.read + read };
  },
};
