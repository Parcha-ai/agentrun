// The run page's rows. A Timeline turns pi's committed entries and the door's agent events into flat rows, one per thing a
// person reads: a user message, thinking, assistant text, a tool call, its result, a phase, a wait, an error. The kinds and
// field names are Grep's public timeline (`kind`, `summary`, `tool_name`, `tool_use_id`, `tool_status`, `*_preview`), with
// a few open fields (`seq`, `round`, `parent_tool_use_id`, `path`, `seconds`). The server builds rows from a live run's
// events and from a released run's store with this one class, so a run looks the same live and after. The page imports
// `group` from this file to pair calls with results and fold calls into groups. Nothing here touches node or the DOM.
export const KINDS = { user: "user_message", thinking: "thinking", text: "text_block", use: "tool_use", result: "tool_result", phase: "phase", waiting: "waiting", error: "error" };

const MAX_TEXT = 2_000;
const MAX_PREVIEW = 500;
const FAMILIES = { run: "Browser", screenshot: "Browser", snapshot: "Browser", web_search: "Web", web_fetch: "Web", read: "Files", write: "Files", edit: "Files", ls: "Files", find: "Files", grep: "Files", bash: "Shell" };
const PREVIEW_KEYS = ["description", "command", "query", "file_path", "url", "path", "code", "what"];

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const line = (text) => clip((text.split("\n").find((l) => l.trim()) ?? "").trim(), 120);
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join(""));
const hidden = (path) => path.split("/").some((part) => part.startsWith("."));
const stamp = (message) => (Number.isFinite(message?.timestamp) ? new Date(message.timestamp).toISOString() : null);
const where = (url) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
};

export const familyOf = (tool) => FAMILIES[tool] ?? (tool.startsWith("browser_") ? "Browser" : tool);

const LABELS = {
  read: (a) => `Read ${a.path ?? "a file"}`,
  write: (a) => `Wrote ${a.path ?? "a file"}`,
  edit: (a) => `Edited ${a.path ?? "a file"}`,
  bash: (a) => `Ran ${clip(line(String(a.command ?? "")), 60)}`,
  web_fetch: (a) => `Fetched ${where(String(a.url ?? ""))}`,
  web_search: (a) => `Searched the web for ${clip(String(a.query ?? ""), 60)}`,
  browser_read: () => "Read the page",
  snapshot: () => "Looked at the page structure",
  screenshot: () => "Took a screenshot",
  browser_downloads: () => "Collected the downloads",
  browser_release: () => "Released the browser session",
  browser_relaunch: () => "Started a fresh browser session",
  run: (a) => {
    const goto = /page\.goto\(\s*["'`]([^"'`]+)["'`]/.exec(typeof a.code === "string" ? a.code : "");
    return goto ? `Opened ${where(goto[1])}` : "Acted on the page";
  },
};

/** A call in words: "Opened example.com/login". The raw input stays one click away. */
export const labelOf = (tool, args = {}) => (LABELS[tool] ? LABELS[tool](args) : `Using tool: ${tool}`);

function preview(args) {
  if (Array.isArray(args.actions)) return clip(args.actions.map((a) => [a.op, a.id ?? a.key ?? a.text ?? ""].join(" ").trim()).join(", "), MAX_PREVIEW);
  const key = PREVIEW_KEYS.find((k) => typeof args[k] === "string");
  if (key) return clip(args[key].split("\n")[0], MAX_PREVIEW);
  return clip(Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", "), MAX_PREVIEW);
}

const clipArgs = (args) => JSON.parse(JSON.stringify(args ?? {}, (_, v) => (typeof v === "string" ? clip(v, 600) : v)));

export class Timeline {
  #rows = new Map();
  #seen = new Set();
  #dirty = new Set();
  #gone = new Set();
  #partial = null;
  #partialIds = new Set();
  #working = false;
  #seq = 0;
  costUsd = 0;

  constructor({ workDir = "" } = {}) {
    this.workDir = workDir.replace(/\/+$/, "");
  }

  get rows() {
    return [...this.#rows.values()];
  }

  /** working while a run is in flight; waiting once the agent ended its turn; idle before the first answer. */
  get state() {
    if (this.#working) return "working";
    const last = this.rows.at(-1);
    return last?.kind === KINDS.waiting && last.reason === "turn_ended" ? "waiting" : "idle";
  }

  /** The rows changed since the last call, and the ids dropped. */
  take() {
    const set = [...this.#dirty].flatMap((id) => (this.#rows.has(id) ? [this.#rows.get(id)] : []));
    const drop = [...this.#gone];
    this.#dirty.clear();
    this.#gone.clear();
    return { set, drop };
  }

  /** The run is released: nothing is in flight. */
  finish() {
    this.#working = false;
    return this;
  }

  #put(row) {
    const old = this.#rows.get(row.id);
    const next = { ...row, seq: old?.seq ?? ++this.#seq };
    if (old && JSON.stringify(old) === JSON.stringify(next)) return;
    this.#rows.set(row.id, next);
    this.#dirty.add(row.id);
  }

  #delete(id) {
    if (!this.#rows.delete(id)) return;
    this.#dirty.delete(id);
    this.#gone.add(id);
  }

  #dropPartial() {
    for (const id of this.#partialIds) this.#delete(id);
    this.#partialIds.clear();
    this.#partial = null;
  }

  #relative(path) {
    const rel = this.workDir && path.startsWith(`${this.workDir}/`) ? path.slice(this.workDir.length + 1) : path.startsWith("/") ? "" : path.replace(/^\.\//, "");
    return rel && !hidden(rel) && !rel.split("/").includes("..") ? rel : "";
  }

  #use(callId, tool, args, extra = {}) {
    const old = this.#rows.get(`t${callId}`);
    if (old) return old;
    const path = typeof args?.path === "string" ? this.#relative(args.path) : "";
    const row = { id: `t${callId}`, kind: KINDS.use, tool_name: tool, tool_use_id: callId, summary: labelOf(tool, args ?? {}), tool_input_preview: preview(args ?? {}), args: clipArgs(args), ...(path ? { path } : {}), ...extra };
    this.#put(row);
    return this.#rows.get(row.id);
  }

  /** A committed entry, from a snapshot, a message_end or a store row. An entry seen twice is a no-op. */
  entry(rec, now = Date.now()) {
    if (this.#seen.has(rec.id)) return;
    this.#seen.add(rec.id);
    const message = rec.model?.[0];
    if (rec.kind === "pi.user" && message) {
      const text = textOf(message.content);
      this.#put({ id: `u${rec.id}`, kind: KINDS.user, text: clip(text, MAX_TEXT), summary: `You: ${line(text)}`, timestamp: stamp(message) });
    } else if (rec.kind === "pi.assistant" && message) this.#assistant(rec, message, now);
    else if (rec.kind === "pi.tool-result" && message) this.#result(rec, message);
    else if (rec.kind === "pi.reset") this.#put({ id: `x${rec.id}`, kind: KINDS.phase, summary: "Context reset" });
    else if (rec.kind === "pi.compaction") this.#put({ id: `x${rec.id}`, kind: KINDS.phase, summary: "Summarized older context" });
  }

  #assistant(rec, message, now) {
    const partial = this.#partial;
    this.#dropPartial();
    this.costUsd += message.usage?.cost?.total ?? 0;
    const timestamp = stamp(message);
    if (message.stopReason === "aborted") return this.#put({ id: `s${rec.id}`, kind: KINDS.phase, summary: "Stopped", timestamp });
    const blocks = message.content ?? [];
    blocks.forEach((block, i) => {
      const id = `a${rec.id}.${i}`;
      if (block.type === "thinking") {
        const began = partial?.content[i]?.type === "thinking" ? partial.at[i] : undefined;
        const seconds = began === undefined ? undefined : Math.max(0, Math.round(((partial.at[i + 1] ?? now) - began) / 1000));
        const text = block.redacted ? "" : block.thinking ?? "";
        this.#put({ id, kind: KINDS.thinking, text: clip(text, MAX_TEXT), summary: `Thinking: ${line(text)}`, ...(block.redacted ? { redacted: true } : {}), ...(seconds === undefined ? {} : { seconds }), timestamp });
      } else if (block.type === "text" && block.text.trim()) this.#put({ id, kind: KINDS.text, text: clip(block.text, MAX_TEXT), summary: line(block.text), timestamp });
      else if (block.type === "toolCall") this.#use(block.id, block.name, block.arguments, { round: rec.id, timestamp });
    });
    if (message.stopReason === "error") {
      const text = message.errorMessage ?? "The model request failed";
      this.#put({ id: `e${rec.id}`, kind: KINDS.error, text: clip(text, MAX_TEXT), summary: `Model request failed: ${line(text)}`, timestamp });
    } else if (!blocks.some((b) => b.type === "toolCall")) this.#put({ id: `w${rec.id}`, kind: KINDS.waiting, reason: "turn_ended", summary: "Waiting for you", timestamp });
  }

  #result(rec, message) {
    const use = this.#use(message.toolCallId, message.toolName ?? "tool", {});
    const failed = message.isError === true;
    const text = textOf(message.content);
    this.#put({ id: `r${message.toolCallId}`, kind: KINDS.result, tool_name: use.tool_name, tool_use_id: use.tool_use_id, tool_status: failed ? "failed" : "success", tool_result_preview: clip(text, MAX_PREVIEW), tool_result_size_bytes: text.length, summary: `${use.summary}: ${failed ? "failed" : "ok"}`, round: use.round, timestamp: stamp(message) });
    if (!failed && (use.tool_name === "write" || use.tool_name === "edit") && use.path) this.#put({ id: `f${message.toolCallId}`, kind: KINDS.phase, summary: `Saved ${use.path}`, path: use.path });
  }

  #update(changes, now) {
    const p = (this.#partial ??= { content: [], at: [] });
    for (const c of changes) {
      const i = c.contentIndex;
      if (c.type === "text_start" || c.type === "thinking_start" || c.type === "toolcall_start") {
        p.content[i] = structuredClone(c.block);
        p.at[i] = now;
      } else if (c.type === "text_delta" && p.content[i]) p.content[i].text += c.delta;
      else if (c.type === "thinking_delta" && p.content[i]) p.content[i].thinking += c.delta;
      else if (c.type === "block") {
        p.content[i] = structuredClone(c.block);
        p.at[i] ??= now;
      } else if (c.type === "message") p.content = structuredClone(c.message.content);
    }
    this.#showPartial();
  }

  #showPartial() {
    this.#partial.content.forEach((block, i) => {
      const id = `p${i}`;
      this.#partialIds.add(id);
      if (block.type === "thinking") this.#put({ id, kind: KINDS.thinking, text: clip(block.thinking ?? "", MAX_TEXT), summary: "Thinking", startedAt: this.#partial.at[i], partial: true });
      else if (block.type === "text") this.#put({ id, kind: KINDS.text, text: clip(block.text ?? "", MAX_TEXT), summary: line(block.text ?? ""), partial: true });
      else if (block.type === "toolCall") this.#put({ id, kind: KINDS.use, tool_name: block.name, tool_use_id: id, summary: labelOf(block.name), tool_input_preview: "", args: {}, partial: true });
    });
  }

  /** One agent event of the door's stream (a snapshot at attach, then each batch's events). */
  event(ev, now = Date.now()) {
    switch (ev.type) {
      case "snapshot":
        for (const rec of ev.entries ?? []) this.entry(rec, now);
        this.#working = Boolean(ev.run);
        if (ev.generation?.message) this.#update([{ type: "message", message: ev.generation.message }], now);
        break;
      case "run_start":
        this.#working = true;
        break;
      case "run_end":
        this.#working = false;
        break;
      case "message_start":
        if (ev.message?.role === "assistant") {
          this.#dropPartial();
          this.#partial = { content: [], at: [] };
        }
        break;
      case "message_update":
        this.#update(ev.changes ?? [], now);
        break;
      case "message_end":
      case "entry_appended":
        this.entry(ev.entry, now);
        break;
      case "tool_execution_start":
        this.#use(ev.toolCallId, ev.toolName, ev.args);
        break;
      case "tool_execution_update": {
        const use = this.#use(ev.toolCallId, ev.toolName, {});
        const out = ev.output;
        if (out && !this.#rows.has(`r${ev.toolCallId}`)) this.#put({ ...use, output: clip("set" in out ? out.set : `${use.output ?? ""}${out.append ?? ""}`, MAX_PREVIEW * 4) });
        break;
      }
      case "tool_execution_end":
        if (ev.entry) this.entry(ev.entry, now);
        else {
          const use = this.#use(ev.toolCallId, ev.toolName, {});
          this.#put({ id: `r${ev.toolCallId}`, kind: KINDS.result, tool_name: use.tool_name, tool_use_id: use.tool_use_id, tool_status: "failed", tool_result_preview: "The tool ended without a result", tool_result_size_bytes: 0, summary: `${use.summary}: interrupted`, round: use.round });
        }
        break;
      case "task_failed": {
        const text = `${ev.kind} failed: ${ev.message}`;
        this.#put({ id: `k${ev.taskId}`, kind: KINDS.error, text: clip(text, MAX_TEXT), summary: `Task failed: ${line(ev.message)}` });
        break;
      }
      case "auto_retry_start":
        this.#put({ id: `y${ev.at}`, kind: KINDS.phase, summary: `Retrying after an error (attempt ${ev.attempt})` });
        break;
    }
  }
}

/**
 * Display items from rows. A call is paired with its result by `tool_use_id` and gets a `status` (running while a live run
 * has no result for it, interrupted once the run is `settled`). Consecutive calls of one family make a group, thinking
 * between two calls of a group is folded into it, and a call that names a `parent_tool_use_id` is nested under it.
 */
export function group(rows, { settled = false } = {}) {
  const results = new Map(rows.filter((r) => r.kind === KINDS.result).map((r) => [r.tool_use_id, r]));
  const calls = new Map(
    rows
      .filter((r) => r.kind === KINDS.use)
      .map((r) => {
        const result = results.get(r.tool_use_id);
        const status = result ? (result.tool_status === "success" ? "ok" : "error") : settled ? "interrupted" : "running";
        return [r.tool_use_id, { ...r, family: familyOf(r.tool_name), result, status, children: [] }];
      }),
  );
  const items = [];
  let held = [];
  const flush = () => {
    items.push(...held);
    held = [];
  };
  for (const row of rows) {
    const last = items.at(-1);
    if (row.kind === KINDS.result) continue;
    if (row.kind === KINDS.thinking && last?.kind === "group") held.push(row);
    else if (row.kind === KINDS.use) {
      const call = calls.get(row.tool_use_id);
      if (row.parent_tool_use_id && calls.has(row.parent_tool_use_id)) calls.get(row.parent_tool_use_id).children.push(call);
      else if (last?.kind === "group" && last.family === call.family) {
        last.items.push(...held, call);
        held = [];
      } else {
        flush();
        items.push({ kind: "group", id: row.id, family: call.family, items: [call] });
      }
    } else {
      flush();
      items.push(row);
    }
  }
  flush();
  return items;
}
