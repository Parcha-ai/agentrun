// The workflow graph, drawn into an SVG: packages/pi-durable-agent/src/serve/graph.js ported to a module, with what the
// console adds on top. The shape comes from the paths alone: a chain is a spine, an escalate step an exit pill off it, a
// route or a parallel fans its branches out under its card and joins them, and a map, a loop or a child workflow is a
// frame around its body. The console adds: a decision node's provider and model, its question count and its image and
// web badges; a map's items as a grid of cells, one per item, each in its state; a decision's verdict on its card; and
// the selected node or item. Every label, branch name and value is data from a workflow document or a run: it reaches the
// drawing only as text nodes, and every attribute is a number, a fixed word or a node's path.
import type { NodeMeta } from "./workflowDoc";

export type GraphInput = { nodes: { path: string; kind: string; label?: string; via?: string }[] };
/** A map item's cell: its state, its name, and, once decided, its outcome (a route's branch), the probability behind it and
 *  the outcome's tone (good, warn, bad). */
export type ItemMark = { index: number; status: string; label?: string; outcome?: string; p?: number; pNote?: string; tone?: "good" | "warn" | "bad" };
export type GraphMarks = {
  diff?: { added?: string[]; edited?: string[]; removed?: { label: string; kind: string }[] };
  /** A state per path: done, working, failed, escalated, stopped, not-run, review, pending. */
  status?: Record<string, string>;
  fired?: string | null;
  taken?: string[];
  meta?: Record<string, NodeMeta>;
  items?: Record<string, ItemMark[]>;
  verdict?: Record<string, string>;
  selected?: { path: string; item?: number | null } | null;
};

const NS = "http://www.w3.org/2000/svg";
const PAD = 16, W = 240, H = 40, HD = 58, GAP = 16, ROW = 26, PILL = 18, TICK = 14, FAN = 16, NAMES = 26, JOIN = 14, BRANCH_GAP = 22, FRAME = 14, LINE = 16;
const CELL = 16, CELL_GAP = 4, COLS = 10, CAPTION = 18;
// A map of up to RICH items draws named cells: the item's name, its outcome and the probability behind it.
const RICH = 30, RCOLS = 5, RW = 124, RH = 34, RGAP = 4, NAME = 10 * 0.6;
// Text is sized by its length: the monospace face advances 0.6em a character (the tags' tracking adds .06em).
const LABEL = 12.5 * 0.6, SMALL = 10.5 * 0.6, NOTE = 11 * 0.6, TAG = 9 * 0.66, VERDICT = 10.5 * 0.6;

const WHO: Record<string, string> = {
  agent: "agent", decide: "agent", extract: "agent", report: "agent", artifact: "agent",
  judge: "jev", pick: "jev", sift: "jev", route: "jev",
  call: "tool", code: "code", escalate: "exit",
  chain: "control", parallel: "control", map: "control", loop: "control", workflow: "control",
};
const STATES = new Set(["done", "working", "held", "failed", "escalated", "stopped", "not-run", "review", "pending"]);
const WORD: Record<string, string> = { review: "needs review", "not-run": "", pending: "" };

type Node = { path: string; kind: string; label: string; via: string };
type Kid = { node: Node; order: number; name: string | null };
type Box = { w: number; h: number; cx: number; exit?: boolean; place: (x: number, y: number) => void };
type Ctx = { svg: SVGSVGElement; kids: Record<string, Kid[]>; marks: GraphMarks; taken: Set<string> };

function el(tag: string, attrs: Record<string, string | number> | null, ...kids: (Node_ | string | null | undefined | (Node_ | string | null)[])[]): SVGElement {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const k of kids) add(n, k);
  return n;
}
type Node_ = SVGElement;
function add(n: SVGElement, kid: Node_ | string | null | undefined | (Node_ | string | null)[]) {
  if (kid == null) return;
  if (Array.isArray(kid)) { for (const k of kid) add(n, k); return; }
  n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
}
const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
/** A verdict clipped in its words, never its number: "advertises_prohib… 0.03". */
const clipVerdict = (t: string, max: number) => {
  const m = /^(.*) (\d\.\d\d)$/.exec(t);
  return !m || t.length <= max ? clip(t, max) : `${clip(m[1], Math.max(2, max - m[2].length - 1))} ${m[2]}`;
};
const fits = (w: number, adv: number) => Math.max(2, Math.floor(w / adv));
const wide = (t: string, adv: number) => Math.ceil(t.length * adv);
const wire = (x1: number, y1: number, x2: number, y2: number, kind?: string) => el("line", { x1, y1, x2, y2, class: kind ? `wire ${kind}` : "wire" });

/** Each node's children by its path: a chain's steps in order, a route's branches with their names, a parallel's
 *  branches, a map's or a loop's body, a child workflow's root. */
function treeOf(nodes: Node[]) {
  const byPath: Record<string, Node> = {};
  const kids: Record<string, Kid[]> = {};
  for (const n of nodes) byPath[n.path] = n;
  const kindAt = (p: string) => byPath[p]?.kind ?? "";
  for (const node of nodes) {
    let m: RegExpExecArray | null;
    const kid: Kid = { node, order: 0, name: null };
    let parent: string | null = null;
    if ((m = /^(.*)\/steps\/(\d+)$/.exec(node.path)) && kindAt(m[1]) === "chain") { parent = m[1]; kid.order = Number(m[2]); }
    else if ((m = /^(.*)\/branches\/([^/]*)\/body$/.exec(node.path)) && kindAt(m[1]) === "route") { parent = m[1]; kid.name = m[2].replace(/~1/g, "/").replace(/~0/g, "~"); }
    else if ((m = /^(.*)\/branches\/(\d+)$/.exec(node.path)) && kindAt(m[1]) === "parallel") { parent = m[1]; kid.order = Number(m[2]); }
    else if ((m = /^(.*)\/body$/.exec(node.path)) && (kindAt(m[1]) === "map" || kindAt(m[1]) === "loop")) parent = m[1];
    else if ((m = /^(.*)\/workflow\/root$/.exec(node.path)) && kindAt(m[1]) === "workflow") parent = m[1];
    if (parent !== null) (kids[parent] ??= []).push(kid);
  }
  for (const k of Object.values(kids)) k.sort((a, b) => a.order - b.order);
  return { byPath, kids };
}

function look(ctx: Ctx, path: string) {
  const { diff = {}, status = {}, fired } = ctx.marks;
  const raw = path === fired ? "escalated" : status[path];
  const state = raw && STATES.has(raw) ? raw : "";
  const tag = diff.added?.includes(path) ? "NEW" : diff.edited?.includes(path) ? "EDITED" : "";
  return { state, tag, fired: path === fired, selected: ctx.marks.selected?.path === path && ctx.marks.selected.item == null };
}

/** A node's group holds its own shapes only, so a state's class never reaches the nodes drawn inside it. */
function group(ctx: Ctx, node: Node, shape: string) {
  const l = look(ctx, node.path);
  const meta = ctx.marks.meta?.[node.path];
  let title = `${node.label} (${node.kind}${node.via ? ` via ${node.via}` : ""}${meta?.provider ? `, ${meta.provider}${meta.model ? ` ${meta.model}` : ""}` : ""})`;
  if (l.state) title += `: ${l.state.replace("-", " ")}`;
  if (l.tag) title += `${l.state ? ", " : ": "}${l.tag.toLowerCase()}`;
  if (meta?.questions?.length) title += `\n${meta.questions.map((q) => `• ${q.text}`).join("\n")}`;
  // A decision is coloured by its provider; a route by a value in the state asks no one, so it is control.
  const who = meta?.decision && meta.provider ? `who-${meta.provider === "parallel" || meta.provider === "openrouter" ? meta.provider : "jev"}`
    : node.kind === "route" && meta && !meta.decision ? "who-control" : `who-${WHO[node.kind] ?? "code"}`;
  let cls = `node ${shape} ${who}`;
  if (l.state) cls += ` ${l.state}`;
  if (l.fired) cls += " fired";
  if (l.tag) cls += ` ${l.tag.toLowerCase()}`;
  if (l.selected) cls += " selected";
  const g = el("g", { class: cls, "data-path": node.path }, el("title", null, title));
  ctx.svg.appendChild(g);
  return g;
}

const tagWidth = (word: string) => wide(word, TAG) + 10;
function tag(g: SVGElement, x: number, y: number, word: string, cls = "tag") {
  const w = tagWidth(word);
  add(g, [el("rect", { x, y, width: w, height: 13, class: `${cls}-box` }), el("text", { x: x + w / 2, y: y + 9.5, class: cls, "text-anchor": "middle" }, word)]);
  return w;
}

const isDecision = (ctx: Ctx, node: Node) => !!ctx.marks.meta?.[node.path]?.decision;
const cardH = (ctx: Ctx, node: Node) => (isDecision(ctx, node) ? HD : H);

/** A card: a square coloured by who works, the label, the kind (and a call's transport or tool), the state's word or the
 *  verdict, the diff's tag on its top edge. A decision card adds a row: its provider, its model, and badges for images and
 *  the web. */
function card(ctx: Ctx, g: SVGElement, node: Node, x: number, y: number) {
  const l = look(ctx, node.path);
  const meta = ctx.marks.meta?.[node.path];
  const h = cardH(ctx, node);
  const verdict = ctx.marks.verdict?.[node.path];
  const word = l.state in WORD ? WORD[l.state] : l.state;
  const nq = meta?.questions?.length ?? 0;
  const kind = node.kind + (meta?.tool ? ` · ${meta.tool}` : node.via ? ` · ${node.via}` : "") + (meta?.decision && nq ? ` · ${nq} ${nq === 1 ? "question" : "questions"}` : "");
  const badges = [meta?.images?.length ? "IMG" : "", meta?.web ? "WEB" : ""].filter(Boolean);
  const badgeW = badges.reduce((s, b) => s + tagWidth(b) + 4, 0);
  if (l.selected) g.appendChild(el("rect", { x: x - 4, y: y - 4, width: W + 8, height: h + 8, class: "sel" }));
  add(g, [
    el("rect", { x, y, width: W, height: h, class: "box" }),
    el("rect", { x: x + 10, y: y + 9, width: 8, height: 8, class: "swatch" }),
    el("text", { x: x + 24, y: y + 17, class: "label" }, clip(node.label, fits(W - 34 - badgeW, LABEL))),
    el("text", { x: x + 24, y: y + 31, class: "kind" }, clip(kind, fits(W - 34 - (word ? wide(word, TAG) + 8 : 0), SMALL))),
    word ? el("text", { x: x + W - 10, y: y + 31, class: "state", "text-anchor": "end" }, word) : null,
  ]);
  let bx = x + W - 8;
  for (const b of badges.reverse()) { bx -= tagWidth(b); tag(g, bx, y + 7, b, "badge"); bx -= 4; }
  if (meta?.decision && meta.provider) {
    // The chip row: the provider, its model, and the verdict on the right (the verdict wins the room).
    const pw = tag(g, x + 24, y + 38, meta.provider, "chip");
    const v = verdict ? clipVerdict(verdict, fits(W - 44 - pw - 20, VERDICT)) : "";
    const room = W - 40 - pw - (v ? wide(v, VERDICT) + 10 : 0);
    if (meta.model && room > 24) g.appendChild(el("text", { x: x + 24 + pw + 6, y: y + 47.5, class: "model" }, clip(meta.model, fits(room, SMALL))));
    if (v) g.appendChild(el("text", { x: x + W - 10, y: y + 47.5, class: "verdict", "text-anchor": "end" }, v));
  } else if (verdict) g.appendChild(el("text", { x: x + W - 10, y: y + 17, class: "verdict", "text-anchor": "end" }, verdict));
  if (l.tag) tag(g, x + W - tagWidth(l.tag), y - 7, l.tag);
}

function leaf(ctx: Ctx, node: Node): Box {
  return { w: W, h: cardH(ctx, node), cx: W / 2, place: (x, y) => card(ctx, group(ctx, node, "card"), node, x, y) };
}

/** An exit: a pill off the spine at x, then its tag and its state's word. */
function exitRow(ctx: Ctx, node: Node, alone: boolean): Box {
  const l = look(ctx, node.path);
  // An exit that is done was passed by: its condition did not hold.
  const word = l.state === "done" ? "passed" : l.state in WORD ? WORD[l.state] : l.state;
  const text = clip(node.label === node.kind ? "exit" : `exit: ${node.label}`, 40);
  const pill = wide(text, SMALL) + 16;
  return {
    w: TICK + pill + (l.tag ? 6 + tagWidth(l.tag) : 0) + (word ? 6 + wide(word, TAG) : 0), h: ROW, cx: 0, exit: true,
    place: (x, y) => {
      const g = group(ctx, node, "exit");
      const mid = y + ROW / 2;
      let at = x + TICK + pill;
      if (alone) g.appendChild(wire(x, y, x, y + ROW, "spine"));
      if (l.selected) g.appendChild(el("rect", { x: x + TICK - 3, y: mid - PILL / 2 - 3, width: pill + 6, height: PILL + 6, class: "sel" }));
      add(g, [
        wire(x, mid, x + TICK, mid, "exit-wire"),
        el("rect", { x: x + TICK, y: mid - PILL / 2, width: pill, height: PILL, class: "exit-box" }),
        el("text", { x: x + TICK + 8, y: mid + 3.5, class: "exit-text" }, text),
      ]);
      if (l.tag) { tag(g, at + 6, mid - 6.5, l.tag); at += 6 + tagWidth(l.tag); }
      if (word) g.appendChild(el("text", { x: at + 6, y: mid + 3.5, class: "state" }, word));
    },
  };
}

/** A chain: its steps down one spine, from each card's bottom to the next card's top through the exits' rows between. */
function chainBox(ctx: Ctx, node: Node, kids: Kid[]): Box {
  const parts = kids.map((k) => (k.node.kind === "escalate" ? exitRow(ctx, k.node, false) : layout(ctx, k.node)));
  let left = W / 2, right = W / 2, h = -GAP;
  for (const p of parts) { left = Math.max(left, p.cx); right = Math.max(right, p.w - p.cx); h += p.h + GAP; }
  return {
    w: left + right, h, cx: left,
    place: (x, y) => {
      const g = group(ctx, node, "chain");
      const spine = x + left;
      let at = y;
      let from: number | null = null;
      parts.forEach((p, i) => {
        if (i) at += GAP;
        if (p.exit) { if (from === null) from = at; }
        else if (from !== null) g.appendChild(wire(spine, from, spine, at, "spine"));
        p.place(p.exit ? spine : spine - p.cx, at);
        at += p.h;
        if (!p.exit) from = at;
      });
      if (parts[parts.length - 1].exit && from !== null) g.appendChild(wire(spine, from, spine, at, "spine"));
    },
  };
}

/** A route or a parallel: its card, a bus its branches hang from (a route's named), and a join under the deepest. */
function fanBox(ctx: Ctx, node: Node, kids: Kid[]): Box {
  const ch = cardH(ctx, node);
  const branches = kids.map((kid) => ({ kid, box: layout(ctx, kid.node), x: 0, c: 0 }));
  let at = 0, deepest = 0;
  branches.forEach((b, i) => { if (i) at += BRANCH_GAP; b.x = at; b.c = at + b.box.cx; at += b.box.w; deepest = Math.max(deepest, b.box.h); });
  const last = branches.length - 1;
  const mid = Math.round((branches[0].c + branches[last].c) / 2);
  const left = Math.min(0, mid - W / 2);
  const right = Math.max(at, mid + W / 2);
  const top = ch + FAN + NAMES;
  const h = top + deepest + JOIN;
  return {
    w: right - left, h, cx: mid - left,
    place: (x, y) => {
      const g = group(ctx, node, "card");
      const o = x - left;
      const bus = y + ch + FAN;
      const join = y + h;
      card(ctx, g, node, o + mid - W / 2, y);
      g.appendChild(wire(o + mid, y + ch, o + mid, bus));
      if (last) add(g, [wire(o + branches[0].c, bus, o + branches[last].c, bus), wire(o + branches[0].c, join, o + branches[last].c, join)]);
      branches.forEach((b, i) => {
        const c = o + b.c;
        const path = b.kid.node.path;
        const taken = ctx.taken.has(path);
        g.appendChild(el("line", { x1: c, y1: bus, x2: c, y2: y + top, class: taken ? "wire branch taken" : "wire branch", "data-to": path }));
        if (b.kid.name !== null) {
          const room = (i < last ? branches[i + 1].c - 6 : b.x + b.box.w) - b.c - 12;
          const name = clip(b.kid.name, fits(room, SMALL));
          const text = el("text", { x: c + 6, y: bus + 15, class: taken ? "branch-name taken" : "branch-name" }, name);
          g.appendChild(name === b.kid.name ? text : el("g", null, el("title", null, b.kid.name), text));
        }
        g.appendChild(wire(c, y + top + b.box.h, c, join, taken ? "taken" : undefined));
        b.box.place(o + b.x, y + top);
      });
    },
  };
}

/** A file's name without its folder and extension, for a cell. */
const shortName = (label: string) => label.replace(/^.*\//, "").replace(/\.(pdf|png|jpe?g|webp|gif|tiff?)$/i, "");

/** A named cell: the item's name on top, its outcome (or its state) and the probability behind it under. */
function richCell(g: SVGElement, node: Node, it: ItemMark, x: number, y: number, picked: boolean) {
  const state = STATES.has(it.status) ? it.status : "pending";
  const name = it.label ? shortName(it.label) : `#${it.index + 1}`;
  const word = it.outcome ?? (state === "review" ? "needs review" : state === "not-run" ? "not run" : state);
  const p = it.p !== undefined ? it.p.toFixed(2) : "";
  const tip = `#${it.index + 1}${it.label ? ` ${it.label}` : ""}: ${state === "review" ? "needs review" : state.replace("-", " ")}${it.outcome ? `, ${it.outcome}` : ""}${it.pNote ? ` (${it.pNote})` : ""}`;
  const cell = el("g", { class: `rcell ${state}${it.tone ? ` tone-${it.tone}` : ""}${picked ? " picked" : ""}`, "data-path": node.path, "data-item": it.index },
    el("title", null, tip),
    el("rect", { x, y, width: RW, height: RH, class: "cell" }),
    el("rect", { x, y, width: 3, height: RH, class: "cell-edge" }),
    el("text", { x: x + 9, y: y + 14, class: "cell-name" }, clip(name, fits(RW - 14, NAME))),
    el("text", { x: x + 9, y: y + 27, class: "cell-out" }, clip(word, fits(RW - 18 - (p ? wide(p, NAME) + 6 : 0), NAME))),
    p ? el("text", { x: x + RW - 6, y: y + 27, class: "cell-p", "text-anchor": "end" }, p) : null);
  g.appendChild(cell);
}

/** A map's items: one cell per item (named cells for a short list, rows of ten small ones past it), and a count of them
 *  by state under the cells. */
function itemGrid(ctx: Ctx, node: Node) {
  const items = ctx.marks.items?.[node.path] ?? [];
  if (!items.length) return null;
  const rich = items.length <= RICH;
  const [cw, chh, gap] = rich ? [RW, RH, RGAP] : [CELL, CELL, CELL_GAP];
  const cols = Math.min(items.length, rich ? RCOLS : COLS);
  const rows = Math.ceil(items.length / cols);
  const w = cols * (cw + gap) - gap;
  const h = rows * (chh + gap) - gap + CAPTION + (rich ? 4 : 0);
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  const tones: Record<string, number> = {};
  for (const it of items) if (it.outcome) tones[it.outcome] = (tones[it.outcome] ?? 0) + 1;
  const outcomes = Object.entries(tones).map(([o, n]) => `${n} ${o}`);
  const parts = [`${counts.done ?? 0}/${items.length} done`, counts.working ? `${counts.working} working` : "", counts.held ? `${counts.held} held` : "", counts.failed ? `${counts.failed} failed` : "", counts.review ? `${counts.review} review` : "", ...outcomes].filter(Boolean);
  const caption = parts.join(" · ");
  return {
    w: Math.max(w, wide(caption, SMALL)), h,
    place: (g: SVGElement, cx: number, y: number) => {
      const x0 = cx - w / 2;
      const sel = ctx.marks.selected;
      items.forEach((it, k) => {
        const x = x0 + (k % cols) * (cw + gap);
        const yy = y + Math.floor(k / cols) * (chh + gap);
        const state = STATES.has(it.status) ? it.status : "pending";
        const picked = sel?.path === node.path && sel.item === it.index;
        if (rich) { richCell(g, node, it, x, yy, picked); return; }
        add(g, el("rect", { x, y: yy, width: CELL, height: CELL, class: `cell ${state}${picked ? " picked" : ""}`, "data-path": node.path, "data-item": it.index },
          el("title", null, `#${it.index + 1}${it.label ? ` ${it.label}` : ""}: ${state === "review" ? "needs review" : state.replace("-", " ")}`)));
      });
      add(g, el("text", { x: cx, y: y + h - 4, class: "caption", "text-anchor": "middle" }, caption));
    },
  };
}

/** A map, a loop or a child workflow: its card on the top edge of a frame around its body; a map's item cells between. */
function frameBox(ctx: Ctx, node: Node, body: Node): Box {
  const inner = layout(ctx, body);
  const ch = cardH(ctx, node);
  const grid = node.kind === "map" ? itemGrid(ctx, node) : null;
  const gh = grid ? grid.h + FRAME : 0;
  const left = Math.max(W / 2, inner.cx, grid ? grid.w / 2 : 0) + FRAME;
  const right = Math.max(W / 2, inner.w - inner.cx, grid ? grid.w / 2 : 0) + FRAME;
  const h = ch + FRAME + gh + inner.h + FRAME;
  return {
    w: left + right, h, cx: left,
    place: (x, y) => {
      const g = group(ctx, node, "card");
      const c = x + left;
      add(g, el("rect", { x, y: y + ch / 2, width: left + right, height: h - ch / 2, class: "frame" }));
      if (grid) {
        add(g, wire(c, y + ch, c, y + ch + FRAME));
        add(g, wire(c, y + ch + FRAME + grid.h, c, y + ch + FRAME + gh));
      } else add(g, wire(c, y + ch, c, y + ch + FRAME));
      add(g, wire(c, y + ch + FRAME + gh + inner.h, c, y + h));
      card(ctx, g, node, c - W / 2, y);
      if (grid) {
        const cells = el("g", { class: "items" });
        grid.place(cells, c, y + ch + FRAME);
        g.appendChild(cells);
      }
      inner.place(c - inner.cx, y + ch + FRAME + gh);
    },
  };
}

function layout(ctx: Ctx, node: Node): Box {
  const kids = ctx.kids[node.path] ?? [];
  if (node.kind === "escalate") return exitRow(ctx, node, true);
  if (!kids.length) return leaf(ctx, node);
  if (node.kind === "chain") return chainBox(ctx, node, kids);
  if (node.kind === "route" || node.kind === "parallel") return fanBox(ctx, node, kids);
  return frameBox(ctx, node, kids[0].node);
}

/** Draws `graph` (the DSL's workflowGraph) into `svg` at its natural size, which CSS shrinks to fit and never grows.
 *  Drawing again clears the last. Returns the drawing's size. */
export function drawWorkflowGraph(svg: SVGSVGElement, graph: GraphInput | null | undefined, marks: GraphMarks = {}): { w: number; h: number } {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.classList.add("wf");
  const nodes: Node[] = (graph && Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((n) => n && typeof n.path === "string" && typeof n.kind === "string")
    .map((n) => ({ path: n.path, kind: n.kind, label: String(n.label ?? n.kind), via: typeof n.via === "string" ? n.via : "" }));
  const tree = treeOf(nodes);
  const size = (w: number, h: number) => {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.style.setProperty("min-width", `${Math.min(w, 480)}px`);
    return { w, h };
  };
  if (!tree.byPath["/root"]) return size(0, 0);
  const ctx: Ctx = { svg, kids: tree.kids, marks, taken: new Set(marks.taken ?? []) };
  const drawn = layout(ctx, tree.byPath["/root"]);
  drawn.place(PAD, PAD);
  let w = drawn.w, h = drawn.h;
  const removed = (marks.diff?.removed ?? []).map((r) => `${r.label} (${r.kind})`);
  if (removed.length) {
    const lines = ["Removed:", ...removed.map((t) => clip(t, fits(Math.max(w, 300), NOTE)))];
    const list = el("g", { class: "removed-list" }, el("title", null, `Removed: ${removed.join(", ")}`));
    lines.forEach((line, i) => { list.appendChild(el("text", { x: PAD, y: PAD + h + 33 + i * LINE, class: "removed" }, line)); w = Math.max(w, wide(line, NOTE)); });
    svg.appendChild(list);
    h += 22 + lines.length * LINE;
  }
  return size(w + 2 * PAD, h + 2 * PAD);
}

/** What a click in the drawing names: an item cell (a map's path and the item's index) or a node's card. */
export function hitOf(target: EventTarget | null): { path: string; item: number | null } | null {
  const t = target as Element | null;
  const cell = t?.closest?.("[data-item]");
  if (cell) return { path: cell.getAttribute("data-path")!, item: Number(cell.getAttribute("data-item")) };
  const g = t?.closest?.("g[data-path]");
  if (!g || g.classList.contains("chain")) return null;
  return { path: g.getAttribute("data-path")!, item: null };
}
