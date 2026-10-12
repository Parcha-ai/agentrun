// What a tool call looks like in the chat: one quiet line, its name and what it was given in a few words; the result opens on tap. Portable, no DOM (main.ts draws it).
import type { ChatItem } from "./chat-view.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;

const LINE = 80;
const clip = (s: string): string => (s.length <= LINE ? s : `${s.slice(0, LINE - 1)}…`);
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A path cut from the front to fit `room`: the file and its folders are what tell it apart, so the tail stays, from a folder boundary when there is one. */
const tailPath = (path: string, room: number): string => {
  if (path.length <= room) return path;
  const tail = path.slice(path.length - (room - 1));
  const slash = tail.indexOf("/");
  return `…${slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
};

/** The arguments as a few words: a command as itself, else the short scalar values in order (a long value, such as a file's content, is not a few words). */
export function toolArgsLine(name: string, args: string): string {
  if (args.trim() === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return clip(flat(args));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return clip(flat(String(parsed)));
  const o = parsed as Record<string, unknown>;
  if (typeof o.command === "string") return clip(flat(o.command));
  // A read's window as the lines it covers (its typed offset and limit), not two bare numbers.
  if (name === "read" && typeof o.path === "string") {
    const offset = typeof o.offset === "number" && Number.isFinite(o.offset) ? o.offset : null;
    const limit = typeof o.limit === "number" && Number.isFinite(o.limit) ? o.limit : null;
    const range = limit !== null ? ` · lines ${offset ?? 1}–${(offset ?? 1) + limit - 1}` : offset !== null ? ` · from line ${offset}` : "";
    return `${tailPath(flat(o.path), LINE - range.length)}${range}`;
  }
  const parts = Object.values(o).flatMap((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [flat(String(v))] : [])).filter((s) => s !== "" && s.length <= 40);
  return clip(parts.join(" · "));
}

/** "1 call", "2 calls". */
export const callsLabel = (n: number): string => `${n} call${n === 1 ? "" : "s"}`;

/** A call that was refused, did not change anything, failed or was cut off: shown in muted type, never as an alarm. */
export function isMuted(tool: Tool): boolean {
  return tool.status === "error" || tool.status === "interrupted" || /^(Not done|No change)\b/i.test(tool.output.trim());
}

/** The tools whose result the next reply repeats word for word: that result is said once (by the reply), so the tool line has nothing to open. */
export function echoedTools(items: readonly ChatItem[]): Set<string> {
  const out = new Set<string>();
  let last: Tool | undefined;
  for (const item of items) {
    if (item.kind === "user") last = undefined;
    else if (item.kind === "tool") last = item;
    else if (item.kind === "assistant" && last && !item.streaming && item.text.trim() !== "" && item.text.trim() === last.output.trim()) {
      out.add(last.id);
      last = undefined;
    } else if (item.kind === "assistant" && item.text.trim() !== "") last = undefined;
  }
  return out;
}

type Switch = Extract<ChatItem, { kind: "switch" }>;

/** A move as one quiet line, from what the notice carried as data (never its text, which is the agent's): where it went and, when Jev decided, how sure. Coming home to the browser is an arrow back. */
export function moveLine(item: Switch): string {
  const to = item.to?.trim() || null;
  const home = to !== null && /\b(browser|tab)\b/i.test(to);
  const where = to === null ? "moved" : home ? "your browser" : to.replace(/^(a|an|the)\s+/i, "");
  const sure = (item.by === "placement" || item.by === "jev") && item.probability != null ? ` · Jev ${item.probability.toFixed(2)}` : "";
  return `${home ? "←" : "→"} ${where}${sure}`;
}

export type ToolKind = "bash" | "write" | "edit" | "read" | "grep" | "find" | "ls" | "other";
const KINDS = new Set<ToolKind>(["bash", "write", "edit", "read", "grep", "find", "ls"]);
export const toolKind = (name: string): ToolKind => (KINDS.has(name as ToolKind) ? (name as ToolKind) : "other");

/** An edit call's changes: pi's `edits: [{oldText, newText}]` (or one pair given directly), as the call wrote them. Null when the arguments are not an edit. */
export function editPairs(args: string): { path: string; pairs: { oldText: string; newText: string }[] } | null {
  let o: unknown;
  try {
    o = JSON.parse(args);
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.path !== "string") return null;
  const pair = (v: unknown): { oldText: string; newText: string } | null => {
    if (v === null || typeof v !== "object") return null;
    const p = v as Record<string, unknown>;
    return typeof p.oldText === "string" && typeof p.newText === "string" ? { oldText: p.oldText, newText: p.newText } : null;
  };
  const pairs = Array.isArray(r.edits) ? r.edits.flatMap((e) => pair(e) ?? []) : (pair(r) ? [pair(r)!] : []);
  return pairs.length === 0 ? null : { path: r.path, pairs };
}

export type Hit = { path: string | null; line: number | null; text: string };

/** The lines of a grep's output: `path:line:text` is a hit; any other line is kept as plain text. */
export function grepHits(output: string): Hit[] {
  return output.split("\n").filter((l) => l !== "").map((l) => {
    const m = /^([^:\s][^:]*):(\d+):(.*)$/.exec(l);
    return m ? { path: m[1]!, line: Number(m[2]), text: m[3]! } : { path: null, line: null, text: l };
  });
}

/** The last `n` lines of an output, and how many lines came before them (a trailing newline is not a line). */
export function tailLines(output: string, n: number): { text: string; hidden: number } {
  const lines = output.replace(/\n$/, "").split("\n");
  if (output === "" || lines.length <= n) return { text: output === "" ? "" : lines.join("\n"), hidden: 0 };
  return { text: lines.slice(-n).join("\n"), hidden: lines.length - n };
}
