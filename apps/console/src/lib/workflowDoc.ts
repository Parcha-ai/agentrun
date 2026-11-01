// A workflow document as the editor reads it: the JSON with where each value sits in the text, what a node asks and of
// whom (provider, model, questions, images), and the problems the console can see before the server checks it. The
// server's check on save is the one that counts; these are hints shown while typing.

import { workflowGraph } from "@dsl/graph";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where a value sits in the text: its first and one-past-last character. */
export type Span = { start: number; end: number };
export type Parsed = { ok: true; value: Json; spans: Map<string, Span> } | { ok: false; error: { message: string; offset: number } };

const seg = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** JSON.parse with each value's span by its JSON Pointer, and a syntax error's offset. */
export function parseWithSpans(text: string): Parsed {
  const spans = new Map<string, Span>();
  let i = 0;
  const fail = (message: string): never => { throw Object.assign(new Error(message), { offset: i }); };
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const str = (): string => {
    const from = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      else if (text.charCodeAt(i) < 0x20) fail("a string cannot hold a raw line break or control character");
      i++;
    }
    if (i >= text.length) { i = from; fail("this string is not closed"); }
    i++;
    try { return JSON.parse(text.slice(from, i)) as string; } catch { i = from; return fail("this string has a bad escape"); }
  };
  const value = (path: string): Json => {
    ws();
    const start = i;
    let out: Json;
    const c = text[i];
    if (c === "{") {
      i++;
      const o: Obj = {};
      ws();
      if (text[i] === "}") i++;
      else for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === "}" ? "a trailing comma before }" : "expected a key in double quotes");
        const k = str();
        ws();
        if (text[i] !== ":") fail("expected : after the key");
        i++;
        o[k] = value(`${path}/${seg(k)}`);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; break; }
        fail("expected , or } after the value");
      }
      out = o;
    } else if (c === "[") {
      i++;
      const a: Json[] = [];
      ws();
      if (text[i] === "]") i++;
      else for (;;) {
        a.push(value(`${path}/${a.length}`));
        ws();
        if (text[i] === ",") { i++; ws(); if (text[i] === "]") fail("a trailing comma before ]"); continue; }
        if (text[i] === "]") { i++; break; }
        fail("expected , or ] after the value");
      }
      out = a;
    } else if (c === '"') out = str();
    else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) fail(i >= text.length ? "the text ends before the value" : "expected a value");
      i += m![0].length;
      out = JSON.parse(m![0]) as Json;
    }
    spans.set(path, { start, end: i });
    return out;
  };
  try {
    const v = value("");
    ws();
    if (i < text.length) fail("text after the end of the JSON");
    return { ok: true, value: v, spans };
  } catch (e) {
    return { ok: false, error: { message: (e as Error).message, offset: (e as { offset?: number }).offset ?? 0 } };
  }
}

/** The 1-based line and column of an offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1, last = -1;
  for (let k = 0; k < Math.min(offset, text.length); k++) if (text[k] === "\n") { line++; last = k; }
  return { line, col: offset - last };
}

/** The value at a JSON Pointer, or undefined. */
export function at(doc: unknown, pointer: string): unknown {
  let v: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(v)) v = v[Number(k)];
    else if (isObj(v)) v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined;
    else return undefined;
  }
  return v;
}

export const DECISION_KINDS = new Set(["judge", "pick", "sift", "route"]);
export const PROVIDERS = ["jev", "parallel", "openrouter"] as const;

export type Question = { id: string; type: "choice" | "noul" | "score"; text: string; options?: string[] };
/** What the graph and the drawer show of a node beside its kind and label. */
export type NodeMeta = {
  decision: boolean;
  provider?: string;
  model?: string;
  questions?: Question[];
  /** The image tokens the node sends (Jev's multimodal look). */
  images?: string[];
  /** Grounded on the web (Parallel). */
  web?: boolean;
  tool?: string;
  unsure?: { branch: string; gte: number };
};

/** A judge schema's properties as questions: an enum is a choice, a boolean a yes/no (noul), an integer with levels a score. */
function questionsOf(schema: unknown): Question[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([id, p]): Question[] => {
    if (!isObj(p)) return [];
    const text = typeof p.description === "string" ? p.description : id;
    if (Array.isArray(p.enum)) return [{ id, type: "choice", text, options: p.enum.map(String) }];
    if (p.type === "boolean") return [{ id, type: "noul", text }];
    if (p.type === "integer") return [{ id, type: "score", text }];
    return [{ id, type: "choice", text }];
  });
}

/** A node's meta from the graph node when it carries it (the engine adds provider, model, questions, images), else from
 *  the workflow JSON at its path. */
export function nodeMeta(workflow: unknown, path: string, graphNode?: Record<string, unknown>): NodeMeta {
  const n = at(workflow, path);
  if (!isObj(n)) return { decision: false };
  const kind = n.node;
  const g = graphNode ?? {};
  const byValue = kind === "route" && typeof n.valuePath === "string";
  // A loop or an escalate whose predicate is `ask` decides too: the graph node says so by carrying its questions.
  const decision = (typeof kind === "string" && DECISION_KINDS.has(kind) && !byValue) || Array.isArray(g.questions);
  if (!decision) return { decision: false, ...(kind === "call" && typeof n.tool === "string" ? { tool: n.tool } : {}) };
  const provider = typeof g.provider === "string" ? g.provider : typeof n.provider === "string" ? n.provider : "jev";
  const model = typeof g.model === "string" ? g.model : typeof n.model === "string" ? n.model : undefined;
  const schemas = isObj(workflow) && isObj(workflow.schemas) ? workflow.schemas : {};
  let questions: Question[] = [];
  if (Array.isArray(g.questions)) questions = (g.questions as { id: string; type: string; instructions?: string; options?: string[] }[])
    .map((q) => ({ id: q.id, type: q.type === "choice" || q.type === "score" ? q.type : "noul", text: q.instructions || q.id, ...(q.options ? { options: q.options } : {}) }));
  else if (kind === "judge" || kind === "sift") questions = typeof n.out === "string" ? questionsOf(schemas[n.out]) : [];
  else if (kind === "pick") questions = [{ id: "pick", type: "choice", text: typeof n.instructions === "string" ? n.instructions : "Pick one" }];
  else if (kind === "route") questions = [{ id: "branch", type: "choice", text: typeof n.instructions === "string" ? n.instructions : "Which branch?", options: isObj(n.branches) ? Object.keys(n.branches) : [] }];
  const images = Array.isArray(g.images) ? (g.images as unknown[]).map(String) : isObj(n.images) ? Object.keys(n.images) : [];
  const unsure = isObj(n.unsure) && typeof n.unsure.branch === "string" && typeof n.unsure.gte === "number" ? { branch: n.unsure.branch, gte: n.unsure.gte } : undefined;
  return { decision, provider, model, questions, ...(images.length ? { images } : {}), web: provider === "parallel", ...(unsure ? { unsure } : {}) };
}

export type Issue = { path: string; message: string; severity: "error" | "warning" };

const KINDS = new Set(["chain", "code", "agent", "decide", "extract", "report", "map", "parallel", "loop", "escalate", "judge", "pick", "sift", "route", "workflow", "artifact", "call"]);

/** The problems visible in the document alone: a node of no known kind, a missing field a kind needs, a schema a judge
 *  names that is not there, an image token the model would never see, an OpenRouter node with no model. */
export function lintWorkflow(doc: unknown): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => out.push({ path, message, severity: "warning" });
  if (!isObj(doc)) { err("", "the workflow is a JSON object"); return out; }
  if (doc.v !== 2) err("/v", 'the workflow format is "v": 2');
  if (typeof doc.name !== "string" || !doc.name) err("/name", "the workflow needs a name");
  const schemas = isObj(doc.schemas) ? doc.schemas : {};
  if (isObj(doc.input) && typeof doc.input.schemaId === "string" && !schemas[doc.input.schemaId]) err("/input/schemaId", `no schema "${doc.input.schemaId}" in schemas`);
  if (!isObj(doc.output)) err("", 'the workflow needs an output: { "schemaId": ..., "path": ... }');
  else if (typeof doc.output.schemaId === "string" && !schemas[doc.output.schemaId]) err("/output/schemaId", `no schema "${doc.output.schemaId}" in schemas`);
  const labels = new Map<string, string>();
  const visit = (n: unknown, p: string): void => {
    if (!isObj(n)) { err(p, "expected a node (an object with a \"node\" kind)"); return; }
    const kind = n.node;
    if (typeof kind !== "string" || !KINDS.has(kind)) { err(`${p}/node`, typeof kind === "string" ? `"${kind}" is not a node kind` : "a node names its kind in \"node\""); return; }
    if (kind !== "chain") {
      if (typeof n.label !== "string" || !n.label) err(p, `a ${kind} node needs a label`);
      else if (labels.has(n.label)) warn(`${p}/label`, `the label "${n.label}" is also used at ${labels.get(n.label)}; receipts name nodes by label`);
      else labels.set(n.label, p);
    }
    const need = (field: string, what: string) => { if (n[field] === undefined) err(p, `a ${kind} node needs ${field} (${what})`); };
    const schema = (field: string) => { if (typeof n[field] === "string" && !schemas[n[field] as string]) err(`${p}/${field}`, `no schema "${n[field]}" in schemas`); };
    switch (kind) {
      case "chain":
        if (!Array.isArray(n.steps) || !n.steps.length) err(p, "a chain needs steps");
        else n.steps.forEach((s, k) => visit(s, `${p}/steps/${k}`));
        break;
      case "parallel":
        if (!Array.isArray(n.branches) || !n.branches.length) err(p, "a parallel node needs branches");
        else n.branches.forEach((s, k) => visit(s, `${p}/branches/${k}`));
        break;
      case "map": need("itemsPath", "where the items are"); need("as", "where the results go"); visit(n.body, `${p}/body`); break;
      case "loop": need("until", "when it stops"); need("maxIters", "a bound"); visit(n.body, `${p}/body`); break;
      case "workflow": if (isObj(n.workflow)) visit(n.workflow.root, `${p}/workflow/root`); else err(p, "a workflow node embeds its workflow"); break;
      case "call":
        need("via", "tool, executor or shell");
        if (n.via === "tool") need("tool", "the tool's name");
        break;
      case "code": if (typeof n.code !== "string") err(p, "a code node needs code"); break;
      case "escalate": need("when", "the predicate that fires it"); need("kind", "the review it asks for"); break;
      case "judge": case "sift": need("out", "the questions' schema"); schema("out"); need("as", "where the answers go"); break;
      case "pick": need("itemsPath", "the options' list"); need("as", "where the pick goes"); break;
      case "agent": case "decide": case "extract": schema("out"); break;
    }
    if (kind === "route") {
      if (!isObj(n.branches) || !Object.keys(n.branches).length) err(p, "a route needs branches");
      else for (const [name, b] of Object.entries(n.branches)) {
        if (!isObj(b)) err(`${p}/branches/${seg(name)}`, `branch "${name}" is an object with a body`);
        else visit(b.body, `${p}/branches/${seg(name)}/body`);
      }
      if (typeof n.valuePath !== "string" && n.instructions === undefined) err(p, "a route asks by instructions (and state), or reads a valuePath");
      if (isObj(n.unsure) && isObj(n.branches) && typeof n.unsure.branch === "string" && !(n.unsure.branch in n.branches)) err(`${p}/unsure/branch`, `the unsure branch "${n.unsure.branch}" is not one of the branches`);
    }
    if (DECISION_KINDS.has(kind) && !(kind === "route" && typeof n.valuePath === "string")) {
      if (n.provider !== undefined && !(PROVIDERS as readonly unknown[]).includes(n.provider)) warn(`${p}/provider`, `provider "${String(n.provider)}" is not one of ${PROVIDERS.join(", ")}`);
      if (n.provider === "openrouter" && typeof n.model !== "string") err(p, "an openrouter decision names its model (e.g. perplexity/pplx-decider-v1.2)");
      if (isObj(n.images)) {
        const seen = JSON.stringify(n.state ?? {}) + JSON.stringify(n.instructions ?? "") + (typeof n.out === "string" ? JSON.stringify(schemas[n.out] ?? {}) : "");
        for (const token of Object.keys(n.images)) if (!seen.includes(token)) err(`${p}/images/${seg(token)}`, `the image token "${token}" must appear in the state or a question, or the model never sees it`);
      }
    }
  };
  if (doc.root === undefined) err("", "the workflow needs a root node");
  else visit(doc.root, "/root");
  return out;
}

/** The span of the nearest value the pointer or one of its parents names. */
export function spanOf(spans: Map<string, Span>, pointer: string): Span | undefined {
  for (let p = pointer; ; p = p.slice(0, p.lastIndexOf("/"))) {
    const s = spans.get(p);
    if (s) return s;
    if (!p) return undefined;
  }
}

/** The innermost node path whose span holds the offset (for "the node under the cursor"). */
export function nodeAtOffset(spans: Map<string, Span>, nodePaths: string[], offset: number): string | null {
  let best: string | null = null, size = Infinity;
  for (const p of nodePaths) {
    const s = spans.get(p);
    if (s && s.start <= offset && offset <= s.end && s.end - s.start < size) { best = p; size = s.end - s.start; }
  }
  return best;
}

/** A workflow in a few words: its nodes, its decisions and who answers them. */
export function workflowShape(workflow: unknown): string {
  const g = workflowGraph(workflow);
  const metas = g.nodes.map((n) => nodeMeta(workflow, n.path, n as unknown as Record<string, unknown>));
  const decisions = metas.filter((m) => m.decision);
  const who = [...new Set(decisions.map((m) => m.provider ?? "jev"))];
  return `${g.nodes.length} nodes · ${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}${who.length ? ` · ${who.join(", ")}` : ""}`;
}
