// The serve page, offline: its three files (src/serve/page.*, served as they are) checked as text (no inline script or style, nothing from the network, no
// HTML sink in the script), then the script run on a small DOM over a fake API whose agent, prompts, runs and rows
// carry markup. Markup must arrive as text: no element the data names, no event attribute, no href but http(s) and
// the page's own hash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const served = (name) => readFileSync(new URL(`../src/serve/${name}`, import.meta.url), "utf8");
const [PAGE_HTML, PAGE_CSS, PAGE_JS] = ["page.html", "page.css", "page.js"].map(served);

// ---- a small DOM: what page.js uses, and HTML sinks that throw ----------------------------------------------------------
class Node {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((kid) => kid !== node);
    node.parentNode = null;
    return node;
  }
  replaceChild(next, old) {
    const at = this.childNodes.indexOf(old);
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[at] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
  get textContent() {
    return this.childNodes.map((kid) => kid.textContent).join("");
  }
  set textContent(text) {
    for (const kid of this.childNodes) kid.parentNode = null;
    this.childNodes = [];
    this.appendChild(new Text(text));
  }
}
class Text extends Node {
  constructor(text) {
    super();
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
}
const sink = (name) => () => {
  throw new Error(`${name} is not allowed`);
};
class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = {};
    this.styles = {};
    this.style = { setProperty: (name, value) => (this.styles[name] = String(value)) };
  }
  setAttribute(name, value) {
    this.attributes.set(name.toLowerCase(), String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get open() {
    return this.attributes.has("open");
  }
  set open(on) {
    if (on) this.setAttribute("open", "");
    else this.removeAttribute("open");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({ type: "click" });
  }
  querySelectorAll(tag) {
    return all(this).filter((node) => node.tagName === tag.toUpperCase());
  }
}
for (const name of ["innerHTML", "outerHTML"]) Object.defineProperty(Element.prototype, name, { get: sink(name), set: sink(name) });
Element.prototype.insertAdjacentHTML = sink("insertAdjacentHTML");

const all = (node) => node.childNodes.flatMap((kid) => (kid instanceof Element ? [kid, ...all(kid)] : []));

/** The page's document and window, its fetch answering from `api` (path to body, or [status, body]), and timers run by
 *  hand. */
function mount(api, hash = "#/") {
  const byId = {};
  const documentElement = new Element("html");
  const body = new Element("body");
  for (const [id, tag] of [["app", "main"], ["crumbs", "nav"], ["theme", "button"]]) {
    byId[id] = new Element(tag);
    byId[id].setAttribute("id", id);
    body.appendChild(byId[id]);
  }
  const document = {
    title: "",
    documentElement,
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new Text(text),
    write: sink("document.write"),
  };
  const fetched = [];
  const timers = new Map();
  let next = 1;
  const hashListeners = [];
  const stored = new Map();
  const window = {
    location: { hash },
    scrollY: 0,
    scrollTo() {},
    localStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) },
    addEventListener: (type, fn) => type === "hashchange" && hashListeners.push(fn),
  };
  const fetch = async (path) => {
    fetched.push(path);
    const answer = api[path];
    const [status, data] = answer === undefined ? [404, { error: "NOT_FOUND", message: `no ${path}` }] : Array.isArray(answer) && typeof answer[0] === "number" ? answer : [200, answer];
    return { ok: status < 300, status, text: async () => JSON.stringify(data) };
  };
  const context = vm.createContext({
    window,
    document,
    fetch,
    URL,
    setTimeout: (fn, ms) => (timers.set(next, { fn, ms }), next++),
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(PAGE_JS, context, { filename: "page.js" });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const nav = (to) => {
    window.location.hash = to;
    for (const fn of hashListeners) fn();
  };
  const go = async (to) => {
    nav(to);
    await settle();
  };
  const tick = async () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, { fn }] of due) fn();
    await settle();
  };
  return { app: byId.app, root: documentElement, theme: byId.theme, document, fetched, timers, settle, nav, go, tick };
}

/** Every element under `node`, and the checks that hold for any data: no element or attribute the data could name. */
function assertInert(node) {
  for (const el of all(node)) {
    assert.ok(!["SCRIPT", "IMG", "SVG", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK", "META", "BASE", "FORM", "INPUT"].includes(el.tagName), `no ${el.tagName} element`);
    for (const [name, value] of el.attributes) {
      assert.ok(!name.startsWith("on") && name !== "style" && name !== "srcdoc" && name !== "src", `no ${name} attribute`);
      if (name === "href") assert.match(value, /^(#|https?:\/\/)/, `href ${value}`);
    }
  }
}

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const AGENT = {
  identity: { id: "desk", name: `Desk ${HOSTILE}`, formatVersion: 1 },
  definition: { name: "Desk", description: `Researches ${HOSTILE}`, instructions: `Be careful ${HOSTILE}`, skills: ["brief"], tools: ["web_fetch", `<b onclick=x>`] },
  source: { sha: "0123456789abcdef0123456789abcdef01234567", refreshedAt: "2026-10-22T20:00:00.000Z" },
  skills: [{ path: `brief/SKILL.md${HOSTILE}`, sha256: "ab".repeat(32), size: 1300 }],
  prompts: [
    { id: "kind", role: "question", label: "Kind", text: `What kind? ${HOSTILE}`, criteria: { public: `listed ${HOSTILE}`, other: "anything else" } },
    { id: "base", role: "base", label: "Base", text: `Research it. ${HOSTILE}` },
    { id: "public", role: "overlay", label: `Public ${HOSTILE}`, text: "Start at the filings.", when: { question: "kind", option: "public", threshold: 0.8 } },
    { id: "generic", role: "generic", label: "Not sure", text: "Start at its own site." },
  ],
  counts: { skills: 1, prompts: 3, questions: 1, runs: 2, live: 0 },
};
const RUN = { id: 'r1"><script>x</script>', startedAt: "2026-10-22T20:01:00.000Z", endedAt: "2026-10-22T20:03:30.000Z", outcome: "completed", cost: 0.44, prompt: { id: "public", reason: `Jev: public at 100% ${HOSTILE}`, confidence: 0.93 }, live: false };
const FAILED = { id: "r0", startedAt: "2026-10-22T19:00:00.000Z", endedAt: "2026-10-22T19:09:00.000Z", outcome: "failed", cost: 0.25, live: false };
const LIVE = { id: "r2", startedAt: "2026-10-22T20:05:00.000Z", prompt: { id: "generic", reason: "no overlay was sure" }, live: true };

const row = (seq, kind, fields = {}) => ({ id: `1:${seq}`, kind, seq, summary: null, text: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, conversation_id: 1, ...fields });
const ROWS = [
  row(0, "user_message", { text: `Research ${HOSTILE}`, summary: "You: Research" }),
  row(1, "thinking", { summary: `Thinking: ${HOSTILE}`, text: HOSTILE }),
  row(2, "tool_use", { tool_name: "web_fetch", tool_use_id: "a", round: 1, summary: `Fetched a.example ${HOSTILE}`, tool_input_preview: HOSTILE }),
  row(3, "tool_result", { tool_name: "web_fetch", tool_use_id: "a", tool_status: "success", tool_result_preview: `<html>${HOSTILE}</html>`, tool_result_size_bytes: 40 }),
  row(4, "tool_use", { tool_name: "web_fetch", tool_use_id: "b", round: 2, summary: "Fetched b.example", tool_input_preview: "https://b.example/" }),
  row(5, "tool_result", { tool_name: "web_fetch", tool_use_id: "b", tool_status: "success", tool_result_preview: "ok", tool_result_size_bytes: 2 }),
  row(6, "tool_use", { tool_name: "read", tool_use_id: "c", round: 3, summary: "Read notes.md" }),
  row(7, "tool_result", { tool_name: "read", tool_use_id: "c", tool_status: "failed", summary: `Read notes.md: ${HOSTILE}`, tool_result_size_bytes: 10 }),
  row(8, "text_block", { text: "See [the filing](https://sec.example/a?b=1), [no](javascript:alert(1)), javascript:alert(2) and https://ok.example/x." }),
  row(9, "usage", { usage: { usd: 0.44, requests: 3 } }),
  row(10, "final_answer", { text: `**Done**: wrote \`brief.md\`.\n\n- ${HOSTILE}\n\n\`\`\`\n${HOSTILE}\n\`\`\`` }),
  // A call the run never finished, as timelineOf settles it.
  row(11, "tool_use", { tool_name: "web_fetch", tool_use_id: "d", round: 4, summary: "Fetched c.example" }),
  { ...row(12, "tool_result", { tool_name: "web_fetch", tool_use_id: "d", tool_status: "failed", summary: "Fetched c.example interrupted", round: 4 }), id: "1:interrupted:d" },
  // A result whose call is not among the rows.
  row(13, "tool_result", { tool_name: "web_fetch", tool_use_id: "gone", tool_status: "failed", summary: `Fetched a page failed: ${HOSTILE}`, tool_result_size_bytes: 20 }),
];

test("the three files: HTML with no inline script or style that links page.css and page.js; CSS and JS that reach nothing outside; no HTML sink in the script", () => {
  const scripts = [...PAGE_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.deepEqual(scripts.map(([, attrs, body]) => [attrs, body]), [[' src="/page.js"', ""]], "one script, page.js, empty, after the elements it fills");
  assert.match(PAGE_HTML, /<link rel="stylesheet" href="\/page\.css">[\s\S]*<main id="app">[\s\S]*<script src="\/page\.js"><\/script>\n<\/body>/);
  assert.doesNotMatch(PAGE_HTML, /<style|\sstyle=|\son[a-z]+=|https?:|\/\//i, "no inline style, no event attribute, nothing from the network");
  assert.doesNotMatch(PAGE_CSS, /@import|url\(|https?:/i, "the CSS loads nothing");
  assert.match(PAGE_CSS, /\*,\*::before,\*::after\{box-sizing:border-box;border-radius:0!important\}/, "square corners everywhere");
  assert.match(PAGE_CSS, /prefers-color-scheme:dark/);
  for (const sinkName of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"style\"", ".style.cssText", "javascript:"]) {
    assert.equal(PAGE_JS.includes(sinkName), false, `page.js has no ${sinkName}`);
  }
  assert.doesNotThrow(() => new vm.Script(PAGE_JS), "the script parses");
});

test("the agent, its prompt decision and its runs: markup in any field is text, and the confidence bar is set through the CSSOM", async () => {
  const page = mount({ "api/agent": AGENT, "api/runs": [RUN, FAILED] });
  await page.settle();
  assertInert(page.app);
  const text = page.app.textContent;
  for (const shown of [`Desk ${HOSTILE}`, `Researches ${HOSTILE}`, `brief/SKILL.md${HOSTILE}`, `What kind? ${HOSTILE}`, `listed ${HOSTILE}`, `Public ${HOSTILE}`, `Jev: public at 100% ${HOSTILE}`, "<b onclick=x>"]) {
    assert.ok(text.includes(shown), `shown as text: ${shown}`);
  }
  assert.equal(page.document.title, `Desk ${HOSTILE} · agent home`, "the title is a string, never parsed");
  assert.ok(text.includes("0.80") && text.includes("93%") && text.includes("$0.440") && text.includes("source 0123456789ab"));
  const runLink = all(page.app).find((el) => el.tagName === "A" && el.getAttribute("class") === "run");
  assert.equal(runLink.getAttribute("href"), `#/runs/${encodeURIComponent(RUN.id)}`, "a run id goes into the hash encoded");
  const bars = all(page.app).filter((el) => el.getAttribute("class")?.startsWith("bar"));
  assert.deepEqual(bars.map((b) => b.styles["--p"]), ["0.8", "0.93"], "the threshold and the confidence");
  assert.deepEqual(page.fetched, ["api/agent", "api/runs"]);
  assert.equal(page.timers.size, 0, "nothing is live, so nothing polls");
  const stats = all(page.app).filter((el) => el.getAttribute("class") === "stat").map((el) => el.textContent);
  assert.deepEqual(stats, ["1skill", "3prompts", "1question", "2runs", "0live"], "each count, named in the singular for one");
  const pills = all(page.app).filter((el) => el.getAttribute("class")?.startsWith("pill "));
  assert.deepEqual(pills.map((el) => [el.getAttribute("class"), el.textContent]), [["pill ok", "completed"], ["pill error", "failed"]], "newest first; a failed run is an error");
});

test("a run's timeline: markup in rows is text, markdown is elements, only http(s) links get an href, calls group and fold", async () => {
  const page = mount({ [`api/runs/${encodeURIComponent(RUN.id)}`]: { run: RUN, rows: ROWS } }, `#/runs/${encodeURIComponent(RUN.id)}`);
  await page.settle();
  assertInert(page.app);
  const text = page.app.textContent;
  for (const shown of [`Research ${HOSTILE}`, `Fetched a.example ${HOSTILE}`, `<html>${HOSTILE}</html>`, `Read notes.md: ${HOSTILE}`, "javascript:alert(2)", "[no](javascript:alert(1))"]) {
    assert.ok(text.includes(shown), `shown as text: ${shown}`);
  }
  const links = all(page.app).filter((el) => el.tagName === "A" && el.getAttribute("target") === "_blank");
  assert.deepEqual(links.map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("rel")]), [
    ["https://sec.example/a?b=1", "the filing", "noopener noreferrer"],
    ["https://ok.example/x", "https://ok.example/x", "noopener noreferrer"],
  ]);
  assert.ok(all(page.app).some((el) => el.tagName === "B" && el.textContent === "Done"), "**Done** is a b element");
  assert.ok(all(page.app).some((el) => el.tagName === "CODE" && el.textContent === "brief.md"));
  assert.ok(all(page.app).some((el) => el.tagName === "PRE" && el.textContent === `${HOSTILE}\n`), "a fence is a pre of text");
  const calls = all(page.app).filter((el) => el.tagName === "DETAILS" && el.getAttribute("class")?.startsWith("call"));
  assert.deepEqual(calls.map((el) => el.getAttribute("class")), ["call many ok", "call ok", "call ok", "call error", "call interrupted"], "the two one-call web_fetch rounds fold; the failed read and the interrupted fetch stand alone");
  assert.ok(text.includes("Fetched c.example interrupted"));
  const alone = all(page.app).filter((el) => el.getAttribute("class") === "row error");
  assert.deepEqual(alone.map((el) => el.textContent), [`Fetched a page failed: ${HOSTILE}`], "a result with no call is an error line of its own");
  assert.ok(text.includes(`Fetched a.example ${HOSTILE} and 1 more`));
  assert.ok(text.includes("4 tool calls") && text.includes("took 2m 30s") && text.includes("93%"));
});

test("a live run refreshes every 2 s until the reader leaves it; a missing run says why; the theme button cycles", async () => {
  const id = encodeURIComponent(LIVE.id);
  const page = mount({ [`api/runs/${id}`]: { run: LIVE, rows: [...ROWS.slice(0, 2), ROWS[9]] }, "api/agent": AGENT, "api/runs": [RUN, LIVE] }, `#/runs/${id}`);
  await page.settle();
  assert.ok(page.app.textContent.includes("$0.440 so far"), "a live run has no cost yet: its last usage row says what it spent");
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [2000]);
  assert.ok(page.app.textContent.includes("refreshing every 2 s"));
  await page.tick();
  assert.deepEqual(page.fetched, [`api/runs/${id}`, `api/runs/${id}`], "fetched again");
  await page.go("#/");
  assert.deepEqual([...page.timers.values()].map((t) => t.ms), [5000], "the overview polls the runs while one is live");
  await page.tick();
  assert.deepEqual(page.fetched.slice(2), ["api/agent", "api/runs", "api/runs"], "the run is no longer fetched");

  // The reader leaves a run before its answer comes: the answer is dropped, not drawn over the overview.
  const raced = mount({ [`api/runs/${id}`]: { run: LIVE, rows: ROWS.slice(0, 2) }, "api/agent": AGENT, "api/runs": [RUN] }, `#/runs/${id}`);
  raced.nav("#/");
  await raced.settle();
  assert.ok(raced.app.textContent.includes("How a run's prompt is picked") && !raced.app.textContent.includes("refreshing every 2 s"));
  assert.equal(raced.timers.size, 0, "and nothing polls the run it left");

  await page.go("#/runs/nope");
  assert.equal(page.timers.size, 0);
  assert.match(page.app.textContent, /Could not read the agent home\. 404 no api\/runs\/nope/);

  assert.equal(page.theme.textContent, "auto");
  page.theme.click();
  assert.deepEqual([page.theme.textContent, page.root.getAttribute("data-theme")], ["light", "light"]);
  page.theme.click();
  page.theme.click();
  assert.deepEqual([page.theme.textContent, page.root.getAttribute("data-theme")], ["auto", null]);
});
