// What a tool call looks like in the chat: one quiet line, its name and what it was given in a few words; the result opens on tap. Portable, no DOM (main.ts draws it).
import type { ChatItem } from "./chat-view.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;

const LINE = 80;
const clip = (s: string): string => (s.length <= LINE ? s : `${s.slice(0, LINE - 1)}…`);
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The arguments as a few words: a command as itself, else the short scalar values in order (a long value, such as a file's content, is not a few words). */
export function toolArgsLine(_name: string, args: string): string {
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
  const parts = Object.values(o).flatMap((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [flat(String(v))] : [])).filter((s) => s !== "" && s.length <= 40);
  return clip(parts.join(" · "));
}

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
