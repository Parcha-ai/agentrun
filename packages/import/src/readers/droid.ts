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
// So a session's requests are its assistant messages, and its total goes on the last of them (the others 0), or on one
// of its own when the transcript holds none. Its cost is the total at the list price of the model that request ran on.
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type FileCursor, type LineSource, lineReader, type ReadContext } from "../lines.js";
import { type Env, entries, type Reader } from "../reader.js";
import { argsOf, isObject, str, textOf } from "../text.js";
import type { Answer, ToolCall, Usage } from "../types.js";
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

/** Text Droid adds to a user message for the model, never the person's words. */
const REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

function record(value: Record<string, unknown>, at: number, { state, seen, keep, add }: ReadContext<undefined>): boolean | void {
  const { session, names } = state;
  if (value.type === "session_start") {
    if (!session.id && str(value.id)) session.id = value.id as string;
    if (str(value.cwd)) session.cwd = value.cwd as string;
    const title = str(value.sessionTitle) ?? str(value.title);
    if (title) session.sourceTitle = title;
    if (str(value.callingSessionId)) {
      session.child = true;
      session.parent = value.callingSessionId as string;
    }
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
    // Without turns, no answer text: the request is kept for its count, in the result and the cursor alike.
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
  idOf: (file) => basename(file, ".jsonl"),
};

/** The settings file as last read: its identity, size and time, and what it held (counts and a model id, no text). */
type Settings = { dev: number; ino: number; size: number; mtimeMs: number; usage?: Usage; model?: string };
export type DroidCursor = { lines: FileCursor; settings?: Settings };

/** The settings file beside `file`, read again only when it changed since `kept`: none when there is none, or it is no
 *  regular file. One that is not whole JSON (being written) holds nothing yet, and is read again next time. */
async function settingsOf(file: string, kept: Settings | undefined): Promise<{ settings?: Settings; read: number }> {
  const path = `${file.replace(/\.jsonl$/, "")}.settings.json`;
  if (!(await lstat(path).catch(() => null))?.isFile()) return { read: 0 };
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return { read: 0 };
  try {
    const { dev, ino, size, mtimeMs } = await handle.stat();
    if (kept && kept.dev === dev && kept.ino === ino && kept.size === size && kept.mtimeMs === mtimeMs) return { settings: kept, read: 0 };
    const bytes = await handle.readFile();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { read: bytes.length };
    }
    const usage = isObject(value) ? normalizeUsage("droid", value.tokenUsage) : undefined;
    const model = isObject(value) ? str(value.model) : undefined;
    return { settings: { dev, ino, size, mtimeMs, ...(usage ? { usage } : {}), ...(model ? { model } : {}) }, read: bytes.length };
  } finally {
    await handle.close();
  }
}

const lines = lineReader(spec);
const none = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const droid: Reader<"droid", DroidCursor> = {
  ...lines,
  async read(locator, cursor, options) {
    const result = await lines.read(locator, cursor?.lines, options);
    const { settings, read } = await settingsOf(locator.file, cursor?.settings);
    const sessions = result.sessions.map(({ locator, session, requests }) => {
      if (!session.model && settings?.model) session.model = modelOf(settings.model);
      const usage = settings?.usage;
      if (!usage) return { locator, session, requests };
      // New requests, never the read's own (its cursor's state holds them): the total on the last, the others 0.
      const last = requests.at(-1);
      const counted: Answer[] = last
        ? requests.map((request) => ({ ...request, usage: request === last ? { ...usage } : none() }))
        : [{ role: "assistant", text: "", calls: [], at: session.endedAt ? Date.parse(session.endedAt) : 0, ...(session.model ? { model: session.model } : {}), usage: { ...usage } }];
      const swap = new Map<unknown, Answer>(requests.map((request, i) => [request, counted[i]!]));
      session.turns = session.turns.map((turn) => swap.get(turn) ?? turn);
      if (!last && options?.turns !== false) session.turns.push(counted[0]!);
      return { locator, session, requests: counted };
    });
    return { ...result, sessions, cursor: { lines: result.cursor, ...(settings ? { settings } : {}) }, read: result.read + read };
  },
};
