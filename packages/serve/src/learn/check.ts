// The checker of a workflow draft a run's compile turn gives its agent's learning folder (SPEC.md): its workflow.json and
// README.md, each a change against what the folder holds. Structure only, and what must never be stored; nothing the
// checker refuses is ever written to git. Every problem it reports is printable: its path and detail are cut of the
// host's secrets and of text shaped like one, and a field over PRINT_MAX is redacted whole.
import { placeholdersOf, placeholderValue } from "@parcha/agentrun-dsl";
import { hiddenCharacter } from "./invisible.js";
import { learnedSecretShapes, redactLearned, valueMatcher } from "./secrets.js";
import { childNodes, type DraftDecisions, type DraftDryRun, draftProblems, type DraftReader, decodedStrings, DECODED_DEPTH, DRY_RUN_FAILED, frontKeys, frontValues, LEARNED_KEYS, learnedPlace, type LearnedPlace, readmeProblems, WORKFLOW_NAME, WORKFLOWS_DIR } from "./workflow-draft.js";

/** Byte caps (UTF-8). Over a cap is refused, never cut. */
export const CAPS = Object.freeze({
  /** One draft's workflow.json. */
  file: 16_384,
  /** One draft's README.md, which the host writes from the one-line description its block gives. */
  readme: 1_024,
});

/** The rule a problem breaks. SPEC.md lists each. */
export type Rule =
  | "outside" | "file_name" | "file_mode" | "encoding" | "deleted" | "too_large" | "invisible_unicode" | "secret_shape"
  | "secret_value" | "workflow" | "no_tool_list" | "executable_node" | "front_matter" | "kept";

/** One problem with a draft, printable as it is. */
export type Problem = { readonly rule: Rule; readonly path?: string; readonly detail: string };

/** One file a draft adds or changes. `mode` is git's (`100644` a regular file, `120000` a link, `040000` a folder;
 *  anything else is not a regular file). A change that is not a deletion carries its bytes. */
export type Change = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly mode?: string;
  readonly size?: number;
  readonly bytes?: Uint8Array;
};

export type DraftCheckInput = {
  readonly changes: readonly Change[];
  /** Values the host holds as secrets: a file, or a file's name, that holds one is refused. */
  readonly refuseValues?: readonly string[];
  /** The tools a workflow draft may name: the agent's granted tools a workflow's call node runs here (tools.ts
   *  learnedWorkflowTools). Without it, a draft that names a tool is refused. */
  readonly tools?: readonly string[];
  /** The agent's granted tools the gate does not allow, with what each is set to (tools.ts learnedDraftTools): a draft
   *  whose call node calls one is refused (workflow-draft.ts gatedNodes). */
  readonly gated?: Readonly<Record<string, string>>;
  /** Where each of `gated`'s denies was set (this agent's settings or this server's), for the refusal's words. */
  readonly deniedBy?: Readonly<Record<string, "agent" | "server" | "default">>;
  /** Explicit host adapter capabilities; absent keeps the managed runner defaults. */
  readonly workflowAdapters?: readonly ("runNode" | "runJudge")[];
  /** The workflow DSL a draft is read with. */
  readonly dsl: DraftReader;
  /** The decision providers a draft's decision nodes may ask, and the gate's setting of each (workflow-draft.ts
   *  DraftDecisions, LS-07). Without them, a draft with a decision node is refused. */
  readonly decisions?: DraftDecisions;
  /** Each draft's dry run (workflow-draft.ts draftDryRun), by its workflow.json's path: one that failed is refused, rule
   *  `workflow`, when the draft has no other problem. A draft with none given is checked without one. */
  readonly dryRuns?: Readonly<Record<string, DraftDryRun>>;
  /** The drafts' files whose text on main has a status (a person retired it, or it waits for its owner's OK): a run
   *  never changes those. A draft's is its README.md. */
  readonly kept?: readonly string[];
};

const MODES: Record<string, string> = { "120000": "a link: never followed", "040000": "a folder: nothing in it was read" };

/** Why a path is none of what a draft may write. */
const OUTSIDE = "a draft writes workflows/<name>/ with its workflow.json and README.md";
/** Why a workflow.json checked with no workflow DSL is refused. */
const NO_DSL = "no workflow DSL to read it with: it was not checked";

/** `problem` as it may be printed: its path and detail cut of `values` and of every shape learning refuses, a bank's
 *  numbers too (redactLearned: a name refused for one never prints it), whole when over PRINT_MAX. */
export const printable = (problem: Problem, values: readonly string[]): Problem => ({
  // A rule is one of Rule's words as the checks write it; a kept row read back is untrusted, so it is cut too.
  rule: redactLearned(problem.rule, values) as Problem["rule"],
  ...(problem.path === undefined ? {} : { path: redactLearned(problem.path, values) }),
  detail: redactLearned(problem.detail, values),
});

type Add = (rule: Rule, detail: string, path?: string) => void;

/** No secret's shape or the host's values in a file's name: a writer picks its files' names, and they reach main, the
 *  index and the logs. */
function nameScanned(path: string, refused: (text: string) => boolean, add: Add): void {
  for (const kind of learnedSecretShapes(path)) add("secret_shape", `its name holds text shaped like a secret (${kind})`, path);
  if (refused(path)) add("secret_value", "its name holds a value the host named as secret", path);
}

/** A file's text, whatever it holds: UTF-8, no hidden character, no secret's shape or the host's values. Undefined,
 *  with why, when it is not. */
function textOf(path: string, bytes: Uint8Array | undefined, refused: (text: string) => boolean, add: Add): string | undefined {
  if (!bytes) throw new TypeError(`${path}: a change that is not a deletion carries its bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return void add("encoding", "it is not UTF-8", path);
  }
  let found = false;
  const hidden = hiddenCharacter(text);
  if (hidden) found = (add("invisible_unicode", `it holds U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")}, a character a reader does not see, at character ${hidden.at}`, path), true);
  for (const kind of learnedSecretShapes(text)) found = (add("secret_shape", `it holds text shaped like a secret (${kind})`, path), true);
  if (refused(text)) found = (add("secret_value", "it holds a value the host named as secret", path), true);
  return found ? undefined : text;
}

/** A learned file at `path` as it is read later, its escapes decoded: a draft's README.md, its front matter read as YAML
 *  reads it (workflow-draft.ts frontValues, the value a harness is served); a draft's workflow.json, every string it
 *  decodes to, keys too, as JSON.parse reads it (workflow-draft.ts decodedStrings, what draftProblems and a learned
 *  call's run read). A hidden character, a secret's shape or the host's value there is refused as one in its text is,
 *  though the text as stored spells it in escapes. True when it found one. */
function decodedScanned(path: string, text: string, refused: (text: string) => boolean, add: Add, deep = true): boolean {
  const place = learnedPlace(path);
  if (!place) return false;
  const decoded = place.kind === "workflow" ? decodedStrings(text) : frontValues(text);
  // Nested past the bound: refused on its own where its item is checked (`deep`), unread where the whole answer is
  // scanned (unstorable), which a draft so deep never reaches storage past.
  if (decoded === "too_deep") return deep ? (add("workflow", `its workflow.json nests deeper than ${DECODED_DEPTH}`, path), true) : false;
  const [values, read] = [decoded, place.kind === "workflow" ? "its JSON, read as JSON reads it," : "its front matter, read as YAML reads it,"];
  let found = false;
  for (const value of values) {
    const hidden = hiddenCharacter(value);
    if (hidden) found = (add("invisible_unicode", `${read} holds U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")}, a character a reader does not see`, path), true);
    // Learning's shapes, a bank's numbers beside their words too (learnedSecretShapes), as the text's own scan reads them.
    for (const kind of learnedSecretShapes(value)) found = (add("secret_shape", `${read} holds text shaped like a secret (${kind})`, path), true);
    if (refused(value)) found = (add("secret_value", `${read} holds a value the host named as secret`, path), true);
  }
  return found;
}

/** The model node kinds a tier routes (model.ts MODEL_NODES); a decision node (judge, pick, sift) goes to its decision
 *  provider, never a tier. */
export const TIERED_KINDS: ReadonlySet<string> = new Set(["agent", "decide", "extract", "report"]);
const isNode = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { node?: unknown }).node === "string";
/** The state key a step writes (the DSL's writeKeyOf): a report's `report_markdown`, else its `as`, else an agent's,
 *  decide's or extract's label. */
const writeKeyOf = (node: Record<string, unknown>): unknown => (node.node === "report" ? "report_markdown" : typeof node.as === "string" && node.as ? node.as : ["agent", "decide", "extract"].includes(node.node as string) ? node.label : undefined);

/** An item's whole state, as a map collects it when neither its resultPath nor its body's `as` picks one key: every
 *  write in the body is in the answer. */
const WHOLE = Symbol("whole state");

/** Why a draft's answer is not written on the agent's own model: each model node that writes the state key its
 *  output.path reads (its answering step) and names tier "fast", one line each, in words the compile retry acts on. A
 *  composed workflow node that writes it answers with its own workflow's answering step, held to the same; a map that
 *  writes it collects each item's result (the DSL's map: its resultPath's key in the item's state, else its body's `as`,
 *  else the item's whole state), so the body's step writing that is the answering one. A map body's other writes stay in
 *  its item and are never the answer; a loop's body writes the state around it. Legwork on fast and an answer on strong
 *  pass. Out of sample (H1), the same answering step on the fast model scored 8.5-9.6 points lower than on the agent's. */
export function answerTierProblems(doc: unknown): string[] {
  const problems: string[] = [];
  const answered = (workflow: unknown): void => {
    const path = (workflow as { output?: { path?: unknown } } | null)?.output?.path;
    if (typeof path !== "string" || !path) return;
    const walk = (node: unknown, key: string | typeof WHOLE): void => {
      if (!isNode(node)) return;
      const writes = key === WHOLE || writeKeyOf(node) === key;
      if (node.node === "workflow") return void (writes && answered(node.workflow));
      if (node.node === "map") {
        if (!writes) return;
        const result = typeof node.resultPath === "string" && node.resultPath ? node.resultPath.split(".")[0] : undefined;
        const bodyAs = isNode(node.body) && typeof node.body.as === "string" && node.body.as ? node.body.as : undefined;
        return walk(node.body, result ?? bodyAs ?? WHOLE);
      }
      if (TIERED_KINDS.has(node.node as string) && node.tier === "fast" && writes) {
        problems.push(`the ${node.node as string} step ${JSON.stringify(String(node.label ?? "(no label)").slice(0, 64))} writes the answer (output.path ${JSON.stringify(path.slice(0, 64))}) on tier "fast": the answering node runs on the agent's model: drop its tier`);
      }
      for (const child of childNodes(node)) walk(child, key);
    };
    walk((workflow as { root?: unknown } | null)?.root, path.split(".")[0]);
  };
  answered(doc);
  return problems;
}

/** The key each page mark stands for (pageStateOf). */
const pageKeyOf = new WeakMap<object, string>();
/** A state holding a page at each of `pages` and nothing else, as a static read sees it: a page has every path (its
 *  fields are the run's), so any path under one reads the page itself. */
function pageStateOf(pages: ReadonlySet<string>): Record<string, unknown> {
  const state: Record<string, unknown> = Object.create(null);
  for (const key of pages) {
    const mark: object = new Proxy(Object.create(null), { get: (_target, prop) => (typeof prop === "string" ? mark : undefined) });
    pageKeyOf.set(mark, key);
    state[key] = mark;
  }
  return state;
}
/** The mark key (pageStateOf) the placeholder `path` reads in `state`, if it reads one. */
const markRead = (state: Record<string, unknown>, path: string): string | undefined => {
  const read = placeholderValue(state, path);
  return read !== null && typeof read === "object" ? pageKeyOf.get(read) : undefined;
};
/** The page keys a value reads: each placeholder in its strings, at any depth, as interpolation fills them (the DSL's
 *  placeholdersOf: `{path?}` only as a whole string, literal text inside a longer one), resolved by the engine's own
 *  lookup (the DSL's placeholderValue: the path as written, so a real `state` key first, then the path after `state.`)
 *  over pageStateOf. A key holding compact facts is absent there, so a `{state.x}` read falls back to `x` as the engine
 *  may when its `state` key lacks `x`. */
function pagesRead(value: unknown, state: Record<string, unknown>, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32) return out;
  if (typeof value === "string") {
    for (const { path } of placeholdersOf(value)) {
      const key = markRead(state, path);
      if (key !== undefined) out.add(key);
    }
  } else if (Array.isArray(value)) value.forEach((one) => pagesRead(one, state, out, depth + 1));
  else if (isObject(value)) Object.values(value).forEach((one) => pagesRead(one, state, out, depth + 1));
  return out;
}

/** Why a draft's model step off the fast tier reads a page (compact state): an agent, decide or extract step with no
 *  `"tier": "fast"` whose `state` map names a key that may hold a page a call step fetched (a call's result, a map's
 *  collected one, a pick or sift over pages, a composed workflow's answer when it is one, the key or anything under it),
 *  or, with no `state` map, which reads the whole state while such a key is in it (pagesRead: the engine's own lookup).
 *  Read in run order: a key holds a page from the step that fetched it until a model step writes over it; a parallel's
 *  branches each start from the same state and their writes merge, so a key one branch replaced is no page after it; a
 *  route runs one branch, so a key stays a page unless every branch replaced it; a loop's body is read pass after pass,
 *  each on every page its passes may leave, until the marks stop changing (within its maxIters); a map's body sees
 *  `item` as a page when its list is one, and its failedAs rows are short errors, never pages; a composed workflow's
 *  child sees an input key as a page when its value reads one. Pages reach a step on the agent's model only through a fast-tier step's
 *  output: chain14b's drafts fed whole pages to the answering step (4.1 requests a run at ~70k cached tokens each,
 *  $0.364 a served run), where the research shape (a fast extract's compact facts to the answering step) booked ~$0.08.
 *  One line each, in words the compile retry acts on. */
export function compactStateProblems(doc: unknown): string[] {
  const problems = new Set<string>();
  const walk = (node: unknown, pages: ReadonlySet<string>, depth: number): Set<string> => {
    const after = new Set(pages);
    if (!isNode(node) || depth > 32) return after;
    const key = writeKeyOf(node);
    const wrote = (page: boolean) => {
      if (typeof key !== "string") return;
      if (page) after.add(key);
      else after.delete(key);
    };
    const kind = node.node as string;
    if (kind === "chain") {
      let state: Set<string> = after;
      for (const step of Array.isArray(node.steps) ? node.steps : []) state = walk(step, state, depth + 1);
      return state;
    }
    if (kind === "parallel") {
      // Every branch starts from the same state and the engine merges their writes (disjoint, or the run fails): a key
      // stays a page when no branch replaced it, and a page a branch wrote is one.
      const outs = (Array.isArray(node.branches) ? node.branches : []).map((body) => walk(body, after, depth + 1));
      const merged = new Set([...after].filter((one) => outs.every((out) => out.has(one))));
      for (const out of outs) for (const one of out) if (!after.has(one)) merged.add(one);
      return merged;
    }
    if (kind === "route") {
      // One branch runs, after the choice is recorded: a page on any branch's way out is one.
      wrote(false);
      const bodies = childNodes(node);
      if (!bodies.length) return after;
      const merged = new Set<string>();
      for (const body of bodies) for (const one of walk(body, after, depth + 1)) merged.add(one);
      return merged;
    }
    if (kind === "loop") {
      // Any pass may be the last (do-while, up to maxIters): walk the body again on every page its passes may leave
      // until the marks stop changing. The set read grows on each further pass, so it stops within one pass a key the
      // workflow names, and never past maxIters; each pass's way out holds the ones before it.
      const passes = typeof node.maxIters === "number" && node.maxIters >= 1 ? Math.floor(node.maxIters) : Number.POSITIVE_INFINITY;
      let read = after;
      let out = walk(node.body, read, depth + 1);
      for (let pass = 2; pass <= passes; pass++) {
        const next = new Set([...read, ...out]);
        if (next.size === read.size) break;
        read = next;
        out = walk(node.body, read, depth + 1);
      }
      return out;
    }
    if (kind === "map") {
      const itemsPage = typeof node.itemsPath === "string" && after.has(node.itemsPath.split(".")[0]!);
      const inner = new Set(after);
      if (itemsPage) inner.add("item");
      else inner.delete("item");
      const out = walk(node.body, inner, depth + 1);
      const result = typeof node.resultPath === "string" && node.resultPath ? node.resultPath.split(".")[0] : isNode(node.body) && typeof node.body.as === "string" && node.body.as ? node.body.as : undefined;
      // Each item's result, or its whole state (the state around the map too) when nothing picks one key.
      wrote(result !== undefined ? out.has(result) : out.size > 0);
      // Its failed items' rows are short error records, never the items.
      if (typeof node.failedAs === "string" && node.failedAs) after.delete(node.failedAs);
      return after;
    }
    if (kind === "workflow") {
      const child = isObject(node.workflow) ? node.workflow : {};
      const input = isObject(node.input) ? node.input : {};
      const state = pageStateOf(after);
      const seen = new Set(Object.entries(input).filter(([, value]) => pagesRead(value, state).size > 0).map(([name]) => name));
      const out = walk(child.root, seen, depth + 1);
      const path = isObject(child.output) && typeof child.output.path === "string" ? child.output.path.split(".")[0]! : "";
      wrote(!!path && out.has(path));
      return after;
    }
    if (kind === "call") return wrote(true), after;
    if (kind === "pick" || kind === "sift") return wrote(typeof node.itemsPath === "string" && after.has(node.itemsPath.split(".")[0]!)), after;
    if (TIERED_KINDS.has(kind) && node.tier !== "fast") {
      const label = JSON.stringify(String(node.label ?? "(no label)").slice(0, 64));
      const read = node.state === undefined ? [...after] : [...pagesRead(node.state, pageStateOf(after))];
      if (read.length) {
        const what = node.state === undefined
          ? `the whole run state (it has no "state" map), the page${read.length > 1 ? "s" : ""} ${read.map((one) => JSON.stringify(one.slice(0, 64))).join(", ")} included`
          : `${read.map((one) => JSON.stringify(`{${one.slice(0, 64)}}`)).join(", ")}, ${read.length > 1 ? "pages" : "a page"} a call step fetched`;
        problems.add(`the ${kind} step ${label} runs off the fast tier and reads ${what}: a page reaches a step on the agent's model only through a fast-tier step's output. Give it a "state" map naming only compact keys (the facts a fast-tier extract step wrote from the pages; in a re-pick loop its own draft too, as "{<its as>?}"), or, for legwork, "tier": "fast"`);
      }
    }
    wrote(false);
    return after;
  };
  walk((doc as { root?: unknown } | null)?.root, new Set(), 0);
  return [...problems];
}

/** The property names that make an answer carry quotes. */
const QUOTE_KEYS: ReadonlySet<string> = new Set(["quote", "quotes"]);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A place in an answer holding quotes: its keys from the answer down ("[]" for an array's items, "*" for any key of a
 *  map), and the quote_missing `path` (from the answer down) and `field` that read them, when one pair can: a quote, a
 *  list of quote strings, or a list of records each holding its quote at `field`. */
type QuoteSite = { keys: string[]; read?: { path: string[]; field?: string } };
const QUOTE_SITES_MAX = 8;

function quoteSite(keys: string[]): QuoteSite {
  const lists = keys.filter((key) => key === "[]").length;
  if (keys.includes("*") || lists > 1) return { keys };
  if (!lists) return { keys, read: { path: keys } };
  const at = keys.indexOf("[]");
  const field = keys.slice(at + 1).join(".");
  return { keys, read: field ? { path: keys.slice(0, at), field } : { path: keys.slice(0, at) } };
}

/** How deep in an answer's schema quotes are looked for: a schema nesting deeper is refused, never read in part. */
const QUOTE_SITE_DEPTH = 16;

/** Every place in `schema` (a draft's output schema, its `#/definitions/<id>` refs read from `schemas`) holding quotes: a
 *  `quote` or `quotes` property that is a string, a list of strings, or holds them deeper (`quotes: [{quote}]`). A quote
 *  key's value is read shape by shape: each `anyOf`/`oneOf` branch, and each kind a `type` list names (a string, and the
 *  list or record beside it), gives its own place, so `quotes: string | [{quote}]` holds quotes at `quotes` and at
 *  `quotes[].quote`. `allOf` members describe one value, so they are read together (the types all of them allow, the
 *  properties and items any of them names). A shape holding structure where no `quote` key is found (records of other
 *  fields) holds quotes no check reads (`*`). `over` when there are more than QUOTE_SITES_MAX places, or the schema
 *  nests past QUOTE_SITE_DEPTH keys or recurs (a definition met again below itself) around quotes: the places found are
 *  then not all of them, and the rule refuses rather than read a part as the whole. */
function quoteSitesOf(schema: unknown, schemas: Record<string, unknown>): { sites: QuoteSite[]; over: boolean } {
  const resolve = (node: unknown): unknown => {
    for (let hops = 0; hops < 8 && isObject(node) && typeof node.$ref === "string"; hops++) {
      const ref = /^#\/definitions\/(.+)$/.exec(node.$ref)?.[1];
      if (ref === undefined || !Object.hasOwn(schemas, ref)) break;
      node = schemas[ref];
    }
    return node;
  };
  const sites: QuoteSite[] = [];
  let over = false;
  const add = (keys: string[]): true => {
    if (sites.some((site) => site.keys.join("\u0000") === keys.join("\u0000"))) return true;
    if (sites.length < QUOTE_SITES_MAX) sites.push(quoteSite(keys));
    else over = true;
    return true;
  };
  // The schemas the walk is inside (cycle detection, one per walk, never a value's other allOf parts, so a definition
  // shared by a part and a property is still read at the property), and those of them it met again below themselves.
  const around = new Set<unknown>();
  const recurring = new Set<unknown>();
  /** `schema` and its `allOf` members (theirs too, refs resolved): the parts of one value, read together. A member the
   *  walk is inside already recurs, read no further. */
  const partsOf = (schema: Record<string, unknown>): Record<string, unknown>[] => {
    const parts: Record<string, unknown>[] = [];
    const take = (node: unknown): void => {
      const part = resolve(node);
      if (!isObject(part) || parts.includes(part)) return;
      if (part !== schema && around.has(part)) return void recurring.add(part);
      parts.push(part);
      if (Array.isArray(part.allOf)) for (const inner of part.allOf) take(inner);
    };
    take(schema);
    return parts;
  };
  /** One schema for the values several parts give one key, list or map: their `allOf`. */
  const together = (values: unknown[]): unknown => (values.length === 1 ? values[0] : { allOf: values });
  /** Walks `node` at `at`; `quoted` when it is a quote key's value (or its items, or a branch of either). Whether it
   *  found a place holding quotes. */
  const walk = (node: unknown, at: string[], quoted = false): boolean => {
    const schema = resolve(node);
    if (over) return false;
    // A quote key's value the schema leaves open (an unresolved ref, `true`) is read as a quote.
    if (!isObject(schema)) return quoted && add(at);
    if (around.has(schema)) {
      recurring.add(schema);
      return false;
    }
    if (at.length > QUOTE_SITE_DEPTH) {
      over = true;
      return false;
    }
    around.add(schema);
    const parts = partsOf(schema);
    // The types every part allows; the other shapes an anyOf/oneOf branch allows, each read alone.
    const typeLists = parts.flatMap((part) => (typeof part.type === "string" ? [[part.type as unknown]] : Array.isArray(part.type) ? [part.type as unknown[]] : []));
    const types = typeLists.length ? typeLists.reduce((all, list) => all.filter((type) => list.includes(type))) : undefined;
    const branches = parts.flatMap((part) => (["anyOf", "oneOf"] as const).flatMap((key) => (Array.isArray(part[key]) ? part[key] as unknown[] : [])));
    const properties = new Map<string, unknown[]>();
    const items: unknown[] = [];
    const extra: unknown[] = [];
    for (const part of parts) {
      if (isObject(part.properties)) for (const [key, inner] of Object.entries(part.properties)) properties.set(key, [...(properties.get(key) ?? []), inner]);
      if (part.items !== undefined) items.push(part.items);
      if (part.additionalProperties !== undefined) extra.push(part.additionalProperties);
    }
    const shaped = properties.size > 0 || items.length > 0 || extra.length > 0;
    // A string here: a type naming it, or no type, branch or shape at all.
    let found = quoted && (types ? types.includes("string") : !branches.length && !shaped) && add(at);
    const structured = !types || types.includes("array") || types.includes("object");
    if (structured) {
      for (const [key, values] of properties) found = walk(together(values), [...at, key], QUOTE_KEYS.has(key)) || found;
      const lists = items.filter(isObject);
      if (lists.length) found = walk(together(lists), [...at, "[]"], quoted) || found;
      const maps = extra.filter(isObject);
      if (maps.length) found = walk(together(maps), [...at, "*"], quoted) || found;
    }
    for (const inner of branches) found = walk(inner, at, quoted) || found;
    around.delete(schema);
    // A quote key's list or record holding no `quote` key and no string: its quotes are where no check reads them.
    if (quoted && structured && !found && (shaped || !branches.length)) found = add([...at, "*"]);
    // A schema met again below itself that holds quotes holds them at ever deeper paths, past any set of checks.
    if (recurring.delete(schema) && found) over = true;
    return found;
  };
  walk(schema, []);
  return { sites, over };
}

/** Whether a node fetches: a call node, or one with a call under it (a composed workflow's included). */
function fetches(node: unknown, depth = 0): boolean {
  if (!isNode(node) || depth > 16) return false;
  if (node.node === "call") return true;
  if (node.node === "workflow") return fetches((node.workflow as { root?: unknown } | null)?.root, depth + 1);
  return childNodes(node).some((child) => fetches(child, depth + 1));
}

/** The nodes writing the state around `root` (its chains, branches and loop bodies; a map's body writes its item's
 *  state and a composed workflow node its child's, so neither is walked). */
function stateWriters(root: unknown): Record<string, unknown>[] {
  const writers: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!isNode(node)) return;
    if (typeof writeKeyOf(node) === "string") writers.push(node);
    if (node.node !== "map" && node.node !== "workflow") for (const child of childNodes(node)) walk(child);
  };
  walk(root);
  return writers;
}

/** Whether `key` in the state around `root` holds a page as fetched, whatever step wrote it last: some step writes it, and
 *  every step writing it writes a page (a model step writing a summary back to the key a call wrote spoils it). */
const holdsPage = (root: unknown, key: string, depth = 0): boolean => {
  const writers = stateWriters(root).filter((writer) => writeKeyOf(writer) === key);
  return writers.length > 0 && writers.every((writer) => writesPage(writer, depth + 1));
};

/** Whether what a node writes is a page as fetched: a call's result; a map's when each item's result (its resultPath's
 *  key, else its body's `as`) holds a page its body fetched, never when it collects the item's whole state, which carries
 *  the state around the map too (an answer written before it included);
 *  a composed workflow's when its child's answer does in the child's state. A model step's summary is no page. */
function writesPage(node: Record<string, unknown>, depth = 0): boolean {
  if (depth > 16) return false;
  if (node.node === "call") return true;
  if (node.node === "map") {
    const result = typeof node.resultPath === "string" && node.resultPath ? node.resultPath.split(".")[0] : undefined;
    const bodyAs = isNode(node.body) && typeof node.body.as === "string" && node.body.as ? node.body.as : undefined;
    const key = result ?? bodyAs;
    return key !== undefined && holdsPage(node.body, key, depth);
  }
  if (node.node === "workflow") {
    const child = isObject(node.workflow) ? node.workflow : {};
    const path = isObject(child.output) && typeof child.output.path === "string" ? child.output.path : "";
    return !!path && holdsPage(child.root, path.split(".")[0], depth);
  }
  return false;
}

/** The state keys around `root` holding a page as fetched (holdsPage), in the order their steps come. */
const pageKeysOf = (root: unknown): string[] => [...new Set(stateWriters(root).map((node) => writeKeyOf(node) as string))].filter((key) => holdsPage(root, key));

/** Whether `node` writes `key` in the state around it (itself, or a step of its chains, branches or loop bodies). */
const writesKey = (node: unknown, key: string): boolean => isNode(node) && (writeKeyOf(node) === key || (node.node !== "map" && node.node !== "workflow" && childNodes(node).some((child) => writesKey(child, key))));

/** Why a draft's quote check is not code: its answer carries quotes (a `quote` or `quotes` property in its output schema)
 *  and it fetches pages (a call step), yet some place in the answer holding quotes has no escalate on quote_missing
 *  reading it after the answer is written (quoteRule), or that escalate reads as a page a key holding no page as fetched
 *  (a model's summary of a page is no page), or, those checks in place, the step writing the answer hands back on its
 *  first miss instead of re-picking once (a loop of REPICK_PASSES until its check passes), or its quotes have more than
 *  one check (a loop's `until` waits on one: the others would hand back with no re-pick). A judge or an `ask` is never the quote check:
 *  H5's judge flagged 149 of 170 answers while 416 of 429 quotes were in the pages, and could not tell the 8 answers
 *  quoting text no page held from the rest; code can. One line each, in words the compile retry acts on. */
export function quoteCheckProblems(doc: unknown): string[] {
  return isObject(doc) ? quoteRule(doc, {}).problems : [];
}

const siteKey = (site: QuoteSite): string => site.keys.join("\u0000");

/** The passes of a checked answer's re-pick loop: the draft, then one re-pick. */
const REPICK_PASSES = 2;
/** A quote_missing predicate as a refusal writes it out. */
type QuoteRead = { readonly path: unknown; readonly field: unknown; readonly pages: readonly unknown[] };
const quoteMissingText = ({ path, field, pages }: QuoteRead): string =>
  `{"predicate": "quote_missing", "path": ${JSON.stringify(path)}${field ? `, "field": ${JSON.stringify(field)}` : ""}, "pages": ${JSON.stringify(pages)}}`;
/** The quote_missing a re-pick loop waits on: `step`'s, when it is a loop of REPICK_PASSES until `not` of a quote_missing. */
const repickCheckOf = (step: unknown): Record<string, unknown> | undefined =>
  isNode(step) && step.node === "loop" && step.maxIters === REPICK_PASSES && isObject(step.until) && step.until.predicate === "not" && isObject(step.until.of) && step.until.of.predicate === "quote_missing" ? step.until.of : undefined;
/** Whether `step` is the re-pick of an answer `check` reads: a loop of REPICK_PASSES until that check's quote_missing (its
 *  path, field and pages) no longer holds. */
const repickOn = (step: unknown, check: QuoteRead): boolean => {
  const of = repickCheckOf(step);
  return !!of && of.path === check.path && (of.field ?? "") === check.field && JSON.stringify(of.pages) === JSON.stringify(check.pages);
};
/** The labels a run's loop events give `workflow`'s quote re-pick (quoteRule `repicks`): what marks a loop's exit a
 *  re-pick (learned-nodes.ts LoopRow `repick`). Any other loop that ran twice is an ordinary loop. */
export function repickLabels(workflow: unknown): Set<string> {
  return new Set(isObject(workflow) ? quoteRule(workflow, {}).repicks : []);
}
/** Whether a step's `state` map names state key `key` as the whole marked placeholder `"{answer?}"` (a whole string):
 *  null on a re-pick loop's first pass, before any draft exists, and the failed draft on its second. No path below the
 *  key counts (`"{answer.x?}"`, `"{state.answer?}"`, unmarked `"{answer}"`): paths are not validated, so only the key
 *  itself is sure to hold the draft. */
function readsDraft(state: unknown, key: string, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof state === "string") return placeholdersOf(state).some(({ path, optional }) => optional && path === key);
  if (Array.isArray(state)) return state.some((one) => readsDraft(one, key, depth + 1));
  return isObject(state) && Object.values(state).some((one) => readsDraft(one, key, depth + 1));
}
/** The labels of the model steps inside `node` (a loop's body) that write state key `key` without reading their own
 *  draft through their `state` map (readsDraft). The DSL sends a step with a map only the keys it names (each pass a
 *  fresh model session), so one not naming the draft never sees it on the re-pick; naming it unmarked (`"{answer}"`)
 *  fails the first pass, which has none yet; and a step with no map reads the whole state, the pages included, which no
 *  step off the fast tier may (compactStateProblems). A map's or a composed workflow's own steps write their item's or
 *  child's state, not this one. */
const blindRepicks = (node: unknown, key: string, depth = 0): string[] => {
  if (!isNode(node) || depth > 32) return [];
  const own = writeKeyOf(node) === key && TIERED_KINDS.has(node.node as string) && !readsDraft(node.state, key) ? [String(node.label ?? node.node).slice(0, 64)] : [];
  const inner = node.node === "map" || node.node === "workflow" ? [] : childNodes(node).flatMap((child) => blindRepicks(child, key, depth + 1));
  return [...own, ...inner];
};
/** How a re-pick step reads its failed draft, as a refusal says it. */
const draftWords = (key: string) => `a "state" map naming the compact facts it answers from and its failed draft as an optional placeholder, "draft": "{${key}?}" (null on the first pass, before any draft exists; the failed draft on the second)`;
/** The labels of the quote_missing escalates inside `node` (a loop's body), a composed workflow's included: each hands
 *  back on the first pass's miss, so a re-pick loop around one never re-picks. */
const quoteEscalatesIn = (node: unknown, depth = 0): string[] => {
  if (!isNode(node) || depth > 32) return [];
  if (node.node === "escalate") return isObject(node.when) && node.when.predicate === "quote_missing" ? [String(node.label ?? "(no label)").slice(0, 64)] : [];
  const inner = node.node === "workflow" && isObject(node.workflow) ? [node.workflow.root] : childNodes(node);
  return inner.flatMap((child) => quoteEscalatesIn(child, depth + 1));
};

/** quoteCheckProblems for one workflow (the draft's, or a composed workflow node's child, its schemas its own else
 *  `schemasAround`): whether the rule applies (its answer carries quotes and it fetches pages), and why it fails. Only a
 *  run's path through its top-level chain is sure to pass a step: a check is an escalate on quote_missing that is a step
 *  of that chain after the last step writing the answer's key (a check in one route branch, or before the answer is
 *  written, reads no answer on another path), and each place in the answer holding quotes needs a check reading it
 *  (its path and field; a place no one pair reads is refused, as quote_missing reads none of it). Its pages are state keys holding a page as
 *  fetched (holdsPage). A composed workflow node writing the whole answer (its `as` the answer's path) whose child
 *  passes this rule in its own state has checked the places in the answer its child's schema declares too; the parent
 *  still checks any other place its own schema declares. `checked`: the places a passing workflow checked. `repicks`:
 *  the answer's re-pick as a run's loop events label it, whether the rule applies or not: the step writing the answer
 *  when it is a loop of REPICK_PASSES until `not` of a quote_missing, else that step's composed child's, which the DSL
 *  labels `<step>/<its label>` (scopeDepsToChild). */
function quoteRule(workflow: Record<string, unknown>, schemasAround: Record<string, unknown>, depth = 0): { applies: boolean; problems: string[]; checked: string[]; repicks: string[] } {
  const output = isObject(workflow.output) ? workflow.output : {};
  const answerPath = typeof output.path === "string" ? output.path : "";
  const schemas = isObject(workflow.schemas) ? workflow.schemas : schemasAround;
  const schemaId = typeof output.schemaId === "string" ? output.schemaId : "";
  if (!answerPath || depth > 8) return { applies: false, problems: [], checked: [], repicks: [] };
  const steps = isNode(workflow.root) && workflow.root.node === "chain" && Array.isArray(workflow.root.steps) ? workflow.root.steps as unknown[] : [workflow.root];
  const answered = steps.findLastIndex((step) => writesKey(step, answerPath.split(".")[0]));
  const writer = steps[answered];
  const child = isNode(writer) && writer.node === "workflow" && isObject(writer.workflow) ? quoteRule(writer.workflow, schemas, depth + 1) : undefined;
  const repicks = !isNode(writer) ? [] : repickCheckOf(writer) ? [String(writer.label)] : (child?.repicks ?? []).map((label) => `${String(writer.label)}/${label}`);
  const none = { applies: false, problems: [], checked: [], repicks };
  if (!Object.hasOwn(schemas, schemaId)) return none;
  // Its refs read as the DSL reads them (resolveSchemaForWorkflow): the schema's own inline definitions first, then the catalog.
  const answerSchema = schemas[schemaId];
  const inline = isObject(answerSchema) && isObject(answerSchema.definitions) ? answerSchema.definitions : {};
  const { sites: declared, over } = quoteSitesOf(answerSchema, { ...schemas, ...inline });
  if ((!declared.length && !over) || !fetches(workflow.root)) return none;
  if (over) return { applies: true, checked: [], repicks, problems: [`the answer's schema (${schemaId.slice(0, 64)}) holds quotes in more than ${QUOTE_SITES_MAX} places or nests past ${QUOTE_SITE_DEPTH} keys, past what the quote check reads, and the workflow fetches pages: give the answer fewer places holding quotes, each a quote, a list of quotes or a list of records holding one`] };
  const where = (site: QuoteSite) => `${schemaId}.${site.keys.join(".").replace(/\.(\[\]|\*)/g, "$1")}`.slice(0, 120);
  const pages = pageKeysOf(workflow.root);
  const covered = child?.applies && !child.problems.length && isNode(writer) && writer.as === answerPath ? child.checked : [];
  const sites = declared.filter((site) => !covered.includes(siteKey(site)));
  const passed = { applies: true, problems: [], checked: declared.map(siteKey), repicks };
  if (!sites.length) return passed;
  // A place no one path and field reads (quotes under two lists, in a map, in records with no quote key): quote_missing
  // would read none of its quotes, so no check passes it.
  const problems = sites.filter((site) => !site.read).map((site) => `the answer carries quotes (${where(site)}) in a shape no quote_missing check reads, and the workflow fetches pages: give them one it reads, a quote, a list of quotes or a list of records each holding its quote at one field`);
  const readable = sites.flatMap((site) => (site.read ? [{ site, read: site.read }] : []));
  if (!pages.length) {
    problems.push(...readable.map(({ site }) => `the answer carries quotes (${where(site)}) and the workflow fetches pages, but no state key holds a page as fetched (a model step's summary of one is no page, a map's or a composed workflow's result included): keep the pages its call steps fetch in the state and check the quotes against them in code with a quote_missing escalate, never a judge`));
  } else {
    const checks = steps.slice(answered + 1).flatMap((step) => {
      if (!isNode(step) || step.node !== "escalate" || !isObject(step.when) || step.when.predicate !== "quote_missing") return [];
      const when = step.when;
      return [{ label: String(step.label ?? "(no label)").slice(0, 64), path: when.path, field: when.field ?? "", pages: Array.isArray(when.pages) ? when.pages as unknown[] : [] }];
    });
    for (const { site, read } of readable) {
      const path = [answerPath, ...read.path].join(".");
      const field = read.field ?? "";
      if (checks.some((check) => check.path === path && check.field === field)) continue;
      const predicate = quoteMissingText({ path, field, pages });
      problems.push(`the answer carries quotes (${where(site)}) and the workflow fetches pages: check them in code, with an escalate ${predicate} as a step of its top-level chain after the step that writes the answer (pages: the state keys its call steps write), never a judge`);
    }
    for (const { label, pages: read } of checks) for (const page of read) {
      const head = typeof page === "string" ? page.split(".")[0] : "";
      if (!pages.includes(head)) problems.push(`the quote_missing escalate ${JSON.stringify(label)} reads ${JSON.stringify(String(page).slice(0, 64))} as a page, which no call step fetched: its pages are the state keys its call steps write (${pages.join(", ")})`);
    }
    // Once the checks hold, the answer re-picks once before one hands back (H5d, preregistered: the answer step once more
    // over the run's pages kept 26 of 31 misses, right 76.9% against the draft's 50.0%, at 11.6% of the agent's cost
    // where handing every miss back cost 21.7%): the step writing it is a loop of REPICK_PASSES until its check passes.
    // A loop's `until` is one predicate and none joins two, so the loop waits on every check only when they are all one
    // check (the same path, field and pages): a loop watching one of several lets the others hand back with no re-pick.
    const [first] = checks;
    const distinct = new Set(checks.map(quoteMissingText)).size;
    if (!problems.length && distinct > 1) {
      problems.push(`the answer's quotes are checked by ${distinct} different quote_missing escalates, and a re-pick loop's "until" reads one check (no predicate joins two), so the loop would let the others hand back with no re-pick: give the answer's quotes one place one check reads (a quote, a list of quotes or a list of records each holding its quote at one field), one quote_missing escalate on it after the step that writes the answer, and that step the body of a loop {"node": "loop", "label": "repick", "maxIters": ${REPICK_PASSES}, "until": {"predicate": "not", "of": <that same quote_missing>}, "body": <the step>}`);
    } else if (!problems.length && first && isNode(writer) && writer.node === "loop" && quoteEscalatesIn(writer.body).length) {
      // A check inside the loop's body hands back on the first draft's miss: the loop never re-picks.
      problems.push(`the re-pick loop ${JSON.stringify(String(writer.label ?? "(no label)").slice(0, 64))} holds the quote_missing escalate ${JSON.stringify(quoteEscalatesIn(writer.body)[0])} in its body, which hands back on the first draft's miss, so the loop never re-picks: the check after the loop, never inside it, as a step of the top-level chain`);
    } else if (!problems.length && first && isNode(writer) && writer.node === "loop" && repickOn(writer, first) && blindRepicks(writer.body, answerPath.split(".")[0]!).length) {
      // The re-pick must see the failed draft, and only through a state map that names it optionally (never the pages).
      problems.push(`the step ${JSON.stringify(blindRepicks(writer.body, answerPath.split(".")[0]!)[0])} in the re-pick loop ${JSON.stringify(String(writer.label ?? "(no label)").slice(0, 64))} writes the answer without reading its failed draft, so its second pass writes the same miss again: give it ${draftWords(answerPath.split(".")[0]!)}. Naming it unmarked ("{${answerPath.split(".")[0]!}}") fails the first pass, and no "state" map reads the whole state, the pages included`);
    } else if (!problems.length && first && !checks.every((check) => repickOn(writer, check))) {
      problems.push(`the step ${JSON.stringify(String(isNode(writer) ? writer.label ?? writer.node : "(no label)").slice(0, 64))} writes the answer and the escalate ${JSON.stringify(first.label)} hands it back on its first quote miss: give it one re-pick first, the step in a loop {"node": "loop", "label": "repick", "maxIters": ${REPICK_PASSES}, "until": {"predicate": "not", "of": ${quoteMissingText(first)}}, "body": <the step>} in its place, the step with ${draftWords(answerPath.split(".")[0]!)} and its instructions saying that a draft there failed the quote check, so a draft quoting text no page holds is written once more and only a second miss hands back: the check after the loop, never inside it`);
    }
  }
  // A composed workflow writing the answer that applies the rule and fails it: its own check is the one to fix.
  if (problems.length && child?.problems.length) return { applies: true, checked: [], repicks, problems: child.problems.map((problem) => `the composed workflow step ${JSON.stringify(String((writer as Record<string, unknown>).label ?? "(no label)").slice(0, 64))} writes the answer: ${problem}`) };
  return problems.length ? { applies: true, problems, checked: [], repicks } : passed;
}

/** What a draft may write of a workflow (`place`), by itself: a good folder name, never a deletion, a regular file
 *  within CAPS.file (a README within CAPS.readme), its text as textOf takes it, and in shape: a draft the DSL validates
 *  against `tools` with no node that runs code (draftProblems), whose answering step runs on the agent's model
 *  (answerTierProblems), whose steps there read no page (compactStateProblems), whose quotes of the pages it fetched are
 *  checked in code (quoteCheckProblems); a README that names its folder and says what the draft is for. */
function learnedChecked(change: Change, place: LearnedPlace, refused: (text: string) => boolean, input: DraftCheckInput, add: Add): void {
  const { path } = change;
  nameScanned(path, refused, add);
  if (!WORKFLOW_NAME.test(place.name)) return add("file_name", "a workflow's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or digit", path);
  if (change.status === "deleted") return add("deleted", "a run never deletes a workflow", path);
  if (change.mode !== undefined && change.mode !== "100644") return add("file_mode", MODES[change.mode] ?? "not a regular file: never read", path);
  const size = change.size ?? change.bytes?.length ?? 0;
  const cap = place.kind === "readme" ? CAPS.readme : CAPS.file;
  if (size > cap) return add("too_large", `${size} bytes; the cap is ${cap}`, path);
  // A person's call stands: a draft whose text on main has a status (retired, or waiting for its owner's OK).
  const readmeOf = `${path.slice(0, path.lastIndexOf("/"))}/README.md`;
  if (input.kept?.includes(path) || (place.kind === "workflow" && input.kept?.includes(readmeOf))) return add("kept", "a person retired it, or it waits for its owner's OK: a run never changes it", path);
  const text = textOf(path, change.bytes, refused, add);
  if (text === undefined || decodedScanned(path, text, refused, add)) return;
  if (place.kind === "workflow") {
    if (!input.dsl) return add("workflow", NO_DSL, path);
    const problems = draftProblems(input.dsl, text, input.tools, input.gated, input.deniedBy, input.decisions, input.workflowAdapters);
    // A draft the DSL reads parses: its answering step is held to the agent's model, its steps there to compact state
    // (the SDK bridge's runNode picks every model itself: it names no tier), and its quote check to code.
    if (!problems.length) {
      const doc = JSON.parse(text);
      const compact = input.workflowAdapters === undefined ? compactStateProblems(doc) : [];
      problems.push(...[...answerTierProblems(doc), ...compact, ...quoteCheckProblems(doc)].map((detail) => ({ rule: "workflow" as const, detail })));
    }
    for (const { rule, detail } of problems) add(rule, detail, path);
    // A draft the checks pass whose dry run failed: its wiring breaks at run time, before any node is paid for.
    const dry = input.dryRuns?.[path];
    if (!problems.length && dry?.status === "failed") add("workflow", dry.detail ?? DRY_RUN_FAILED, path);
    return;
  }
  for (const reason of readmeProblems(text, place.name)) add("workflow", reason, path);
  // Its front matter says what it is and nothing more: a reader takes directives from any other key. `status` is the
  // host's (`kept`).
  const extra = (frontKeys(text) ?? []).filter((key) => !LEARNED_KEYS.includes(key) && key !== "status");
  if (extra.length) add("front_matter", `its front matter sets ${extra.join(", ")}: a learned workflow sets name and description alone`, path);
}

/** What must never be stored, in every change's name and text, whatever the checks would refuse it for first: the
 *  name and text scans (nameScanned, textOf) of each change, its text read whole (a file over its cap, one not a regular
 *  file included), printable as checkDraft's are. A text that is not UTF-8 is `encoding`: unread, so never trusted.
 *  Empty when nothing in them must be refused. */
export function unstorable(changes: readonly Change[], refuseValues: readonly string[] = []): Problem[] {
  const problems: Problem[] = [];
  const add: Add = (rule, detail, path) => void problems.push(printable(path === undefined ? { rule, detail } : { rule, path, detail }, refuseValues));
  const refused = valueMatcher(refuseValues);
  for (const change of changes) {
    nameScanned(change.path, refused, add);
    const text = change.bytes ? textOf(change.path, change.bytes, refused, add) : undefined;
    if (text !== undefined) decodedScanned(change.path, text, refused, add, false);
  }
  return problems;
}

/** Checks one workflow draft (its workflow.json and README.md, given together by draftFiles) against SPEC.md: each file
 *  under workflows/<name>/ (learnedChecked), nothing else, and the two together (a workflow whose files are otherwise in
 *  shape with one of them missing names it: restore reads the README). Never throws: a draft it could not read (no
 *  workflow DSL, a check that threw) is a problem in words. Every problem printable; none when it passes. */
export function checkDraft(input: DraftCheckInput): Problem[] {
  const values = input.refuseValues ?? [];
  const problems: Problem[] = [];
  const add: Add = (rule, detail, path) => void problems.push(printable(path === undefined ? { rule, detail } : { rule, path, detail }, values));
  const refused = valueMatcher(values);
  /** Each workflow's files given, by its name. */
  const given = new Map<string, Set<LearnedPlace["kind"]>>();
  for (const change of input.changes) {
    const place = learnedPlace(change.path);
    if (!place) {
      nameScanned(change.path, refused, add);
      add("outside", OUTSIDE, change.path);
      continue;
    }
    if (change.status !== "deleted") given.set(place.name, (given.get(place.name) ?? new Set()).add(place.kind));
    try {
      learnedChecked(change, place, refused, input, add);
    } catch (error) {
      add("workflow", `it could not be checked: ${String((error as Error)?.message ?? error).slice(0, 200)}`, change.path);
    }
  }
  for (const [name, kinds] of given) {
    const dir = `${WORKFLOWS_DIR}/${name}/`;
    if (kinds.size === 2 || problems.some((problem) => problem.path?.startsWith(dir))) continue;
    const missing = kinds.has("workflow") ? "README.md" : "workflow.json";
    add("workflow", `${OUTSIDE}: its ${missing} is missing`, `${dir}${missing}`);
  }
  return problems;
}
