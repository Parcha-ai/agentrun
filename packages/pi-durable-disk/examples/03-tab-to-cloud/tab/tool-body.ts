// What a tool call shows when it is opened: bash its command and output, write and edit the diff, grep and the like their hits, read the text it read, anything else its result. DOM, no state: main.ts
// gives it what it knows of the workspace (`before`, a file's text as it was before a write) and it draws. The diff is drawn by @pierre/diffs, loaded on first use (code-view.ts).
import type { ChatItem } from "./chat-view.ts";
import { editPairs, grepHits, tailLines, toolKind } from "./chat-lines.ts";
import { humanizeOutput, type OutputLine } from "./trainer-lines.ts";
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
/** A log is read from its end: the last `n` characters, and a note of how many came before. */
const OUT_FULL = 200_000;
const clipStart = (s: string, n: number): string => (s.length <= n ? s : `… ${s.length - n} earlier characters\n${s.slice(-n)}`);

function parse(args: string): Record<string, unknown> {
  try {
    const o = JSON.parse(args) as unknown;
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const TAIL = 8;

/**
 * A command's output: the last few lines, with how many came before, until the reader asks for all of it (a training log is hundreds of lines and streams in: what matters is where it is now).
 * The toggle is part of the body, so a redraw while the output grows shows the tail again unless the reader had opened it (`open` keeps that, by call id, in main.ts).
 */
type OutputOpts = { expanded: boolean; onToggle?: (expanded: boolean) => void; raw?: boolean; onRaw?: (raw: boolean) => void };

function outputBlock(text: string, opts: OutputOpts): HTMLElement {
  const h = humanizeOutput(text);
  return h.recognized === 0 ? rawOutputBlock(text, opts) : trainerBlock(h.lines, text, opts);
}

/** The raw text, with its last lines (see outputBlock). */
function rawOutputBlock(text: string, opts: OutputOpts): HTMLElement {
  const tail = tailLines(text, TAIL); // the last lines of the whole output, however long (a training log's progress is at its end)
  const tailText = clipStart(tail.text, OUT_CAP);
  const full = clipStart(text, OUT_FULL);
  const wrap = el("div", "output");
  const pre = el("pre", "out", opts.expanded || tail.hidden === 0 ? full : tailText);
  if (tail.hidden > 0) {
    const more = el("button", "more", opts.expanded ? "show the last lines" : `${tail.hidden} earlier line${tail.hidden === 1 ? "" : "s"}`);
    more.setAttribute("type", "button");
    more.addEventListener("click", () => {
      const now = pre.dataset.expanded !== "1";
      pre.dataset.expanded = now ? "1" : "";
      pre.textContent = now ? full : tailText;
      more.textContent = now ? "show the last lines" : `${tail.hidden} earlier line${tail.hidden === 1 ? "" : "s"}`;
      opts.onToggle?.(now);
    });
    if (opts.expanded) pre.dataset.expanded = "1";
    wrap.append(more);
  }
  wrap.append(pre);
  return wrap;
}

/**
 * A trainer's output (pi-run prints one JSON event per line) as quiet lines: compiling, training, each checkpoint with its number against its target, passing in green, the rest of the lines as they were. The last 8
 * lines show with how many came before; the raw output is one click away and stays chosen across redraws.
 */
function trainerBlock(lines: readonly OutputLine[], text: string, opts: OutputOpts): HTMLElement {
  const wrap = el("div", "output trainer");
  const mode = el("button", "more", opts.raw ? "quiet view" : "raw output");
  mode.setAttribute("type", "button");
  const body = el("div", "tbody");
  let raw = opts.raw === true;
  let all = opts.expanded;
  const draw = () => {
    mode.textContent = raw ? "quiet view" : "raw output";
    if (raw) return void body.replaceChildren(rawOutputBlock(text, { expanded: opts.expanded }));
    const shown = all || lines.length <= TAIL ? lines : lines.slice(-TAIL);
    const rows = shown.map((l) => el("div", `tl ${l.kind}`, l.text));
    const hidden = lines.length - shown.length;
    if (lines.length > TAIL) {
      const more = el("button", "more", all ? "show the last lines" : `${hidden} earlier line${hidden === 1 ? "" : "s"}`);
      more.setAttribute("type", "button");
      more.addEventListener("click", () => {
        all = !all;
        opts.onToggle?.(all);
        draw();
      });
      body.replaceChildren(more, ...rows);
    } else body.replaceChildren(...rows);
  };
  mode.addEventListener("click", () => {
    raw = !raw;
    opts.onRaw?.(raw);
    draw();
  });
  draw();
  wrap.append(mode, body);
  return wrap;
}

/** A placeholder that becomes the diff when it is drawn (the library loads on first use). */
function diffInto(slot: HTMLElement, path: string, oldText: string, newText: string): void {
  slot.textContent = "…";
  void diffElement(path, oldText, newText).then(
    (d) => slot.replaceChildren(d),
    (e: unknown) => slot.replaceChildren(el("pre", "out", `(the diff could not be drawn: ${e instanceof Error ? e.message : String(e)})`)),
  );
}

/** Whether a call has anything to open, without building it (a diff is not drawn until its row is opened): the same cases as toolBody. */
export function hasBody(tool: Tool, opts: { showOutput: boolean }): boolean {
  const kind = toolKind(tool.name);
  const args = parse(tool.args);
  if (kind === "bash" && typeof args.command === "string") return true;
  if (kind === "write" && typeof args.path === "string" && typeof args.content === "string") return true;
  if (kind === "edit" && editPairs(tool.args) !== null) return true;
  if ((kind === "grep" || kind === "find" || kind === "ls") && tool.output) return true;
  return tool.output !== "" && opts.showOutput;
}

/**
 * The body of one tool call, or null when there is nothing to open (no arguments worth showing and no output). `showOutput` is false when the reply repeats the result word for word
 * (the reply says it once). `before` is a file's text before a write replaced it, when the page saw it (a write to a new file has none, and shows as all additions).
 */
export function toolBody(tool: Tool, opts: { showOutput: boolean; before?: string | undefined; expanded?: boolean; onToggle?: (expanded: boolean) => void; raw?: boolean; onRaw?: (raw: boolean) => void }): HTMLElement | null {
  const kind = toolKind(tool.name);
  const args = parse(tool.args);
  const body = el("div", "tool-body");
  const out = tool.output && opts.showOutput ? tool.output : "";
  if (kind === "bash" && typeof args.command === "string") {
    body.append(el("pre", "cmd", `$ ${args.command}`));
    if (out) body.append(outputBlock(out, { expanded: opts.expanded === true, raw: opts.raw === true, ...(opts.onToggle ? { onToggle: opts.onToggle } : {}), ...(opts.onRaw ? { onRaw: opts.onRaw } : {}) }));
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
