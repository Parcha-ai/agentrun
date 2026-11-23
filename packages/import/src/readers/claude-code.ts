// Claude Code: ~/.claude/projects/<cwd slug>/<session id>.jsonl, its subagents' in <session id>/subagents/ (children).
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { addRequest, setUsage } from "../counts.js";
import { type LineSource, lineReader, type ReadContext } from "../lines.js";
import { type Env, entries } from "../reader.js";
import { addRecord, ownerOf, type RecordIndex, recordIndex } from "../record-index.js";
import { packed, packInto } from "../record-key.js";
import { argsOf, effortOf, INTERRUPTED, isObject, str, textOf } from "../text.js";
import type { Answer, SessionOf, ToolCall } from "../types.js";
import { normalizeUsage } from "../usage.js";

type Own = {
  /** This file's requests by key (keyOf), each a turn its later lines join. */
  keyed: Map<string, Answer>;
  /** A totals read's instead: each request's index in its counts, by its key packed (packInto). */
  indexes?: RecordIndex;
  /** The calls of requests that were copies, whose results are copies too. */
  copied: Set<string>;
  /** Its titles (titleRecord), and its records' uuids, for the summaries' leaves. */
  titles: { custom?: string; ai?: string; summaries: { title: string; leaf?: string }[]; uuids: Set<string> };
};

// The titles Claude Code writes into a session's file, each again as it changes, and the field each holds it in.
const TITLES = new Map([
  ["custom-title", "customTitle"],
  ["ai-title", "aiTitle"],
  ["summary", "summary"],
]);

/** One of Claude Code's title records: kept by kind, the latest of each. A summary names the last message of the
 *  conversation it titles (leafUuid), which can be another session's: held until the file's end. */
function titleRecord(value: Record<string, unknown>, session: SessionOf, titles: Own["titles"]): void {
  // As written: the cut matches a key or a passphrase as the source wrote it, so the title is put on one line after it.
  const title = str(value[TITLES.get(value.type as string)!])?.trim();
  if (!title || (str(value.sessionId) && value.sessionId !== session.id)) return;
  if (value.type === "custom-title") titles.custom = title;
  else if (value.type === "ai-title") titles.ai = title;
  else titles.summaries.push({ title, ...(str(value.leafUuid) ? { leaf: value.leafUuid as string } : {}) });
}

/** A request's key: its message id with the request id it was sent as (ccusage's pair). Claude Code writes one line per
 *  content block of a response, each with both. */
const keyOf = (message: Record<string, unknown>, value: Record<string, unknown>): string | undefined => {
  const id = str(message.id);
  const request = str(value.requestId);
  return id && request ? `${id}:${request}` : id;
};

const PACKED = packed();

/** Claude Code's record; false for one read already (the import's earlier file, or this file's own repeat). */
function record(value: Record<string, unknown>, at: number, { state, seen, keep, add }: ReadContext<Own>): boolean | void {
  const { session, names, own, counts } = state;
  // Claude Code names a session's file for its id (<id>.jsonl): the file's own, whatever a record in it says. A resumed
  // session's file can open with records copied from the session it resumed, each still naming that one.
  if (!session.id) session.id = basename(session.file, ".jsonl");
  if (!session.cwd && str(value.cwd)) session.cwd = value.cwd as string;
  if (value.isSidechain === true) session.child = true;
  // A totals read keeps no title, nor the uuids a summary's is checked against.
  if (TITLES.has(value.type as string)) return counts ? undefined : titleRecord(value, session, own.titles);
  if (str(value.uuid) && !counts) own.titles.uuids.add(value.uuid as string);
  if (value.type === "cost-state") {
    // The last one is the session's: unknown when the CLI could not price a model it used.
    session.costUsd = typeof value.totalCostUSD === "number" && Number.isFinite(value.totalCostUSD) && value.totalCostUSD >= 0 && value.hasUnknownModelCost !== true ? value.totalCostUSD : undefined;
    return;
  }
  // A record written twice (a session carried on in its own file, or copied into a resumed one's) is read once, and moves
  // no time a second time, whatever its type.
  const uuid = str(value.uuid);
  if (uuid && seen.has(`u:${uuid}`)) return false;
  if (uuid) seen.add(`u:${uuid}`);
  if ((value.type !== "user" && value.type !== "assistant") || !isObject(value.message)) return;
  if (value.isMeta === true || value.isCompactSummary === true || value.isVisibleInTranscriptOnly === true) return;
  const mark = uuid ? { uuids: [uuid] } : {};
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
        arguments: keep ? argsOf(b.input) : {},
      }));
    // A tool's name is for its result's turn: none is kept without turns.
    if (keep) for (const call of calls) names.set(call.id, call.name);
    // The CLI's own turns (model <synthetic>): one marked an API error is a request that failed; any other ("No response
    // requested.") is no request, kept as the CLI's note.
    const failed = value.isApiErrorMessage === true;
    if (synthetic && !failed) {
      if (text) add({ role: "note", author: "Claude Code", text, at, ...mark });
      return;
    }
    session.state = failed ? "failed" : "completed";
    // One request's blocks come as lines of one key, a parallel call's result between two of them: one turn. Each line
    // repeats the request's usage, and the last one written holds its final counts (an earlier one may hold only the
    // stream's start): the last line's usage is the request's.
    const key = keyOf(message, value);
    const usage = normalizeUsage("anthropic", message.usage);
    if (counts) {
      // A totals read: the request's model and usage alone, its later lines' usage over it, as below.
      const indexes = (own.indexes ??= recordIndex(64));
      const at = key ? packInto(key, PACKED) : undefined;
      const index = at ? ownerOf(indexes, at) : -1;
      if (index !== -1) {
        if (usage) setUsage(counts, index, usage);
        return;
      }
      if (key && (seen.has(`m:${key}`) || (str(message.id) && seen.has(`l:${message.id}`)))) {
        for (const call of calls) own.copied.add(call.id);
        return false;
      }
      if (!key && !text && calls.length === 0) return;
      const added = addRequest(counts, session.model, usage);
      if (at) {
        addRecord(indexes, at, added);
        seen.add(`m:${key}`);
      }
      return;
    }
    const held = key ? own.keyed.get(key) : undefined;
    if (held) {
      if (keep) held.text = [held.text, text].filter(Boolean).join("\n");
      held.calls.push(...calls);
      if (uuid) held.uuids = [...(held.uuids ?? []), uuid];
      if (usage) held.usage = usage;
      return;
    }
    // A request an earlier file of the import holds: counted there, never again; its calls' results are copies too. A
    // store imported before requests were keyed by message and request id holds the bare message id ("l:", serve's).
    if (key && (seen.has(`m:${key}`) || (str(message.id) && seen.has(`l:${message.id}`)))) {
      for (const call of calls) own.copied.add(call.id);
      return false;
    }
    if (!key && !text && calls.length === 0) return;
    const effort = effortOf(value.perTurnEffort) ?? effortOf(value.effort);
    // Without turns, no answer text: the request is kept for its counts, in the result and the cursor alike.
    const turn: Answer = { role: "assistant", text: keep ? text : "", calls, at, ...(key ? { key } : {}), ...(session.model ? { model: session.model } : {}), ...(effort ? { effort } : {}), ...(usage ? { usage } : {}), ...(failed ? { error: text || "API error" } : {}), ...mark };
    if (key) {
      own.keyed.set(key, turn);
      seen.add(`m:${key}`);
    }
    add(turn);
    return;
  }
  if (typeof message.content === "string") {
    if (INTERRUPTED.test(message.content)) session.state = "stopped";
    else session.state = "completed";
    return add({ role: "user", text: message.content, at, ...mark });
  }
  if (!Array.isArray(message.content)) return;
  const said: string[] = [];
  let results = 0;
  let copies = 0;
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") said.push(block.text);
    else if (block.type === "tool_result") {
      const id = String(block.tool_use_id ?? "");
      results += 1;
      if (own.copied.has(id)) {
        copies += 1;
        continue;
      }
      add({
        role: "toolResult",
        callId: id,
        name: names.get(id) ?? "",
        text: textOf(block.content),
        isError: block.is_error === true,
        at,
        ...mark,
      });
    }
  }
  if (said.length) {
    const text = said.join("\n");
    session.state = INTERRUPTED.test(text) ? "stopped" : "completed";
    add({ role: "user", text, at, ...mark });
  }
  // Results of copied calls alone: a copy, which moves no time either.
  if (results > 0 && copies === results && !said.length) return false;
}

/** Claude Code's subagents' session files under `home`, in <session id>/subagents/ (a workflow's a folder deeper), each
 *  with the session file it ran under (`of`): the one beside the folder it sits in. A session moved to another project
 *  folder keeps its id there, with copies of its subagents' files: each folder's are its own file's. Never through a
 *  link. */
export async function childFiles(home: string, env?: Env): Promise<{ file: string; of: string }[]> {
  const root = join(configDir(home, env), "projects");
  const out: { file: string; of: string }[] = [];
  for (const project of await entries(root)) {
    if (!project.isDirectory()) continue;
    for (const session of await entries(join(root, project.name))) {
      if (!session.isDirectory()) continue;
      const walk = async (dir: string, depth: number): Promise<void> => {
        for (const entry of await entries(dir)) {
          if (entry.isDirectory() && depth < 3) await walk(join(dir, entry.name), depth + 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push({ file: join(dir, entry.name), of: join(root, project.name, `${session.name}.jsonl`) });
        }
      };
      // The folder itself is no link: one that points elsewhere holds no subagent of this session's.
      const subagents = join(root, project.name, session.name, "subagents");
      if ((await lstat(subagents).catch(() => null))?.isDirectory()) await walk(subagents, 0);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Claude Code's own directory: CLAUDE_CONFIG_DIR where the environment names it, else ~/.claude. */
const configDir = (home: string, env?: Env): string => env?.CLAUDE_CONFIG_DIR || join(home, ".claude");

const spec: LineSource<"claude-code", Own> = {
  source: "claude-code",
  name: "Claude Code",
  harness: "claude-agent",
  async files(home, env) {
    const root = join(configDir(home, env), "projects");
    const out: string[] = [];
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      for (const file of await entries(join(root, project.name))) if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(root, project.name, file.name));
    }
    return out;
  },
  // By project folder, oldest written first: the first file holding a copied record keeps it.
  order: (a, b) => dirname(a.file).localeCompare(dirname(b.file)) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file),
  children: childFiles,
  start: () => ({ keyed: new Map(), copied: new Set(), titles: { summaries: [], uuids: new Set() } }),
  record,
  finish(out, turns, { state: { own } }) {
    const { titles } = own;
    const sourceTitle = titles.custom ?? titles.ai ?? titles.summaries.findLast(({ leaf }) => leaf === undefined || titles.uuids.has(leaf))?.title;
    if (sourceTitle) out.sourceTitle = sourceTitle;
    return turns;
  },
  idOf: (file) => basename(file, ".jsonl"),
  // A turns: false cursor keeps no title: a read resumed from it gives none.
  forget: (own) => ({ ...own, titles: { summaries: [], uuids: new Set() } }),
};

export const claudeCode = lineReader(spec);
