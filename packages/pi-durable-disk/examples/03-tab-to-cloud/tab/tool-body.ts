// What a tool call shows when it is opened: bash its command and output, write and edit the diff, grep and the like their hits, read the text it read, anything else its result. DOM, no state: main.ts
// gives it what it knows of the workspace (`before`, a file's text as it was before a write) and it draws. The diff is drawn by @pierre/diffs, loaded on first use (code-view.ts).
import type { ChatItem } from "./chat-view.ts";
import { editPairs, grepHits, toolKind } from "./chat-lines.ts";
import { diffElement } from "./code-view.ts";

type Tool = Extract<ChatItem, { kind: "tool" }>;

const el = (tag: string, cls: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const OUT_CAP = 6000;
const clip = (s: string): string => (s.length <= OUT_CAP ? s : `${s.slice(0, OUT_CAP)}\n… ${s.length - OUT_CAP} more characters`);

function parse(args: string): Record<string, unknown> {
  try {
    const o = JSON.parse(args) as unknown;
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A placeholder that becomes the diff when it is drawn (the library loads on first use). */
function diffInto(slot: HTMLElement, path: string, oldText: string, newText: string): void {
  slot.textContent = "…";
  void diffElement(path, oldText, newText).then(
    (d) => slot.replaceChildren(d),
    (e: unknown) => slot.replaceChildren(el("pre", "out", `(the diff could not be drawn: ${e instanceof Error ? e.message : String(e)})`)),
  );
}

/**
 * The body of one tool call, or null when there is nothing to open (no arguments worth showing and no output). `showOutput` is false when the reply repeats the result word for word
 * (the reply says it once). `before` is a file's text before a write replaced it, when the page saw it (a write to a new file has none, and shows as all additions).
 */
export function toolBody(tool: Tool, opts: { showOutput: boolean; before?: string | undefined }): HTMLElement | null {
  const kind = toolKind(tool.name);
  const args = parse(tool.args);
  const body = el("div", "tool-body");
  const out = tool.output && opts.showOutput ? tool.output : "";
  if (kind === "bash" && typeof args.command === "string") {
    body.append(el("pre", "cmd", `$ ${args.command}`));
    if (out) body.append(el("pre", "out", clip(out)));
  } else if (kind === "write" && typeof args.path === "string" && typeof args.content === "string") {
    const slot = el("div", "slot");
    body.append(slot);
    diffInto(slot, args.path, opts.before ?? "", args.content);
    if (out && tool.status !== "done") body.append(el("pre", "out", clip(out)));
  } else if (kind === "edit") {
    const e = editPairs(tool.args);
    if (e) {
      for (const p of e.pairs) {
        const slot = el("div", "slot");
        body.append(slot);
        diffInto(slot, e.path, p.oldText, p.newText);
      }
      if (out && tool.status !== "done") body.append(el("pre", "out", clip(out)));
    } else if (out) body.append(el("pre", "out", clip(out)));
  } else if ((kind === "grep" || kind === "find" || kind === "ls") && tool.output) {
    const list = el("div", "hits");
    for (const h of grepHits(tool.output)) {
      const row = el("div", h.path === null ? "hit plain" : "hit");
      if (h.path !== null) row.append(el("span", "where", `${h.path}:${h.line}`), el("span", "what", h.text));
      else row.append(el("span", "what", h.text));
      list.append(row);
    }
    body.append(list);
  } else if (out) {
    body.append(el("pre", "out", clip(out)));
  }
  return body.childElementCount === 0 ? null : body;
}
