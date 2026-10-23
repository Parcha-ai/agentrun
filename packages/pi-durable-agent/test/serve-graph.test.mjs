// The serve page's workflow graph, offline: src/serve/graph.js (served as it is) run on a small SVG DOM, drawing the
// DSL's workflowGraph output with a diff's marks and a run's state. The shape comes from the paths alone; labels, branch
// names and removed nodes carry markup, which must arrive as text: no element but the drawing's own, no event or style
// attribute, no class a status value names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const served = (name) => readFileSync(new URL(`../src/serve/${name}`, import.meta.url), "utf8");
const [GRAPH_JS, PAGE_CSS] = ["graph.js", "page.css"].map(served);
const SVG = "http://www.w3.org/2000/svg";
const SHAPES = ["g", "rect", "line", "path", "text", "title"];

// ---- a small SVG DOM: what graph.js uses, and HTML sinks that throw ------------------------------------------------------
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
  constructor(tag, ns) {
    super();
    this.namespaceURI = ns;
    this.tagName = tag;
    this.attributes = new Map();
    this.styles = {};
    this.style = { setProperty: (name, value) => (this.styles[name] = String(value)) };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
}
for (const name of ["innerHTML", "outerHTML"]) Object.defineProperty(Element.prototype, name, { get: sink(name), set: sink(name) });
Element.prototype.insertAdjacentHTML = sink("insertAdjacentHTML");

const all = (node) => node.childNodes.flatMap((kid) => (kid instanceof Element ? [kid, ...all(kid)] : []));
const classes = (el) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const has = (el, name) => classes(el).includes(name);
const num = (el, name) => Number(el.getAttribute(name));

/** graph.js run in its own context with only a document that makes SVG elements, and the svg it draws into. */
function mount() {
  const document = { createElementNS: (ns, tag) => new Element(tag, ns), createTextNode: (text) => new Text(text), createElement: sink("createElement"), write: sink("document.write") };
  const window = {};
  vm.runInContext(GRAPH_JS, vm.createContext({ window, document }), { filename: "graph.js" });
  const svg = new Element("svg", SVG);
  svg.setAttribute("class", "graph");
  return { svg, draw: (graph, marks) => (assert.equal(window.drawWorkflowGraph(svg, graph, marks), undefined), svg) };
}

const groups = (svg) => all(svg).filter((el) => el.getAttribute("data-path") !== null);
const group = (svg, path) => {
  const found = groups(svg).filter((el) => el.getAttribute("data-path") === path);
  assert.equal(found.length, 1, `one group for ${path}`);
  return found[0];
};
const inside = (el, cls) => all(el).filter((kid) => has(kid, cls));
const words = (el, cls) => inside(el, cls).map((kid) => kid.textContent);
const titleOf = (el) => el.childNodes.find((kid) => kid.tagName === "title")?.textContent;
const STATES = ["done", "working", "failed", "escalated", "not-run", "stopped", "skipped"];
const stateOf = (el) => classes(el).filter((name) => STATES.includes(name));

const node = (path, kind, label = kind, via) => ({ path, kind, label, ...(via ? { via } : {}) });
const PRIVATE = "/root/steps/2/branches/private/body";
const FIRED = `${PRIVATE}/steps/1`;
/** workflowGraph's output for a chain of five: an agent, an exit, a route whose private branch is a chain with its own
 *  exit, a map, and a report. */
const GRAPH = {
  nodes: [
    node("/root", "chain"),
    { ...node("/root/steps/0", "agent", "Find the filings"), changeCheck: "0badf00d" },
    node("/root/steps/1", "escalate", "no filings at all"),
    node("/root/steps/2", "route", "Kind of company"),
    node("/root/steps/2/branches/public/body", "call", "Read the 10-K", "http"),
    node(PRIVATE, "chain"),
    node(`${PRIVATE}/steps/0`, "judge", "Is it registered"),
    node(FIRED, "escalate", "not registered"),
    node("/root/steps/3", "map", "Each officer"),
    node("/root/steps/3/body", "agent", "Screen the officer"),
    node("/root/steps/4", "report", "Write the brief"),
  ],
  edges: [
    { from: "/root", to: "/root/steps/0", kind: "next" },
    { from: "/root/steps/0", to: "/root/steps/1", kind: "next" },
    { from: "/root/steps/1", to: "/root/steps/2", kind: "next" },
    { from: "/root/steps/2", to: "/root/steps/2/branches/public/body", kind: "route" },
    { from: "/root/steps/2", to: PRIVATE, kind: "route" },
    { from: PRIVATE, to: `${PRIVATE}/steps/0`, kind: "next" },
    { from: `${PRIVATE}/steps/0`, to: FIRED, kind: "next" },
    { from: "/root/steps/2", to: "/root/steps/3", kind: "next" },
    { from: "/root/steps/3", to: "/root/steps/3/body", kind: "item" },
    { from: "/root/steps/3", to: "/root/steps/4", kind: "next" },
  ],
};
const CARDS = ["/root/steps/0", "/root/steps/2", "/root/steps/3", "/root/steps/4"];
const box = (svg, path) => inside(group(svg, path), "box")[0];
const centre = (rect) => num(rect, "x") + num(rect, "width") / 2;

test("the script: a classic script with no HTML sink and no rounded corner, and page.html loads it before page.js", () => {
  for (const sinkName of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createElement(", "eval(", "new Function", "setAttribute(\"style\"", ".style.cssText", "javascript:"]) {
    assert.equal(GRAPH_JS.includes(sinkName), false, `graph.js has no ${sinkName}`);
  }
  assert.doesNotThrow(() => new vm.Script(GRAPH_JS), "the script parses as a classic script");
  assert.doesNotMatch(GRAPH_JS, /^\s*(import|export)\b/m, "no module syntax");
  assert.doesNotMatch(GRAPH_JS, /["']r[xy]["']|\br[xy]\s*:/, "no rx or ry");
  assert.match(served("page.html"), /<script src="\/graph\.js"><\/script>\n<script src="\/page\.js"><\/script>/, "graph.js runs first, so page.js finds drawWorkflowGraph");
});

test("a chain with an exit, a route with two branches and a map: one group per node by its path, on one spine, with the branch names as text", () => {
  const { draw } = mount();
  const svg = draw(GRAPH);
  const paths = groups(svg).map((el) => el.getAttribute("data-path"));
  assert.deepEqual([...paths].sort(), GRAPH.nodes.map((n) => n.path).sort(), "one group per graph node, and no other");
  assert.ok(has(svg, "graph") && has(svg, "wf"), "the svg keeps its own class and gains the drawing's");

  const spine = centre(box(svg, "/root/steps/0"));
  assert.deepEqual(CARDS.map((path) => centre(box(svg, path))), CARDS.map(() => spine), "the root chain's cards are centred on its spine");
  const rows = CARDS.map((path) => num(box(svg, path), "y"));
  assert.deepEqual([...rows].sort((a, b) => a - b), rows, "top to bottom in step order");
  const wires = inside(group(svg, "/root"), "spine");
  assert.ok(wires.length >= 3, "spine wires join the root chain's steps");
  for (const wire of wires) assert.deepEqual([num(wire, "x1"), num(wire, "x2")], [spine, spine], "a spine wire is on the spine");
  assert.equal(inside(group(svg, "/root"), "box").length, 0, "a chain is its spine, not a card");

  const exit = group(svg, "/root/steps/1");
  assert.ok(has(exit, "exit"), "an escalate step is an exit");
  const pill = inside(exit, "exit-box")[0];
  assert.ok(num(pill, "x") > spine, "its pill sits off the spine");
  assert.ok(num(pill, "y") > num(box(svg, "/root/steps/0"), "y") && num(pill, "y") < num(box(svg, "/root/steps/2"), "y"), "between the steps around it");
  assert.equal(inside(exit, "exit-wire").length, 1, "and a wire reaches it from the spine");
  assert.deepEqual(words(exit, "exit-text"), ["exit: no filings at all"]);

  const branches = inside(group(svg, "/root/steps/2"), "branch");
  assert.deepEqual(branches.map((el) => el.getAttribute("data-to")), ["/root/steps/2/branches/public/body", PRIVATE], "a branch wire to each branch's body");
  assert.ok(num(branches[0], "x1") < spine && num(branches[1], "x1") > spine, "the branches fan out on either side of the route");
  assert.deepEqual(words(group(svg, "/root/steps/2"), "branch-name"), ["public", "private"], "each branch is named");
  assert.equal(centre(box(svg, "/root/steps/2/branches/public/body")), num(branches[0], "x1"), "a branch's body hangs from its wire");
  assert.equal(centre(box(svg, `${PRIVATE}/steps/0`)), num(branches[1], "x1"));
  assert.ok(num(inside(group(svg, FIRED), "exit-box")[0], "x") > num(branches[1], "x1"), "the private branch's exit sits off its own spine");

  const frame = inside(group(svg, "/root/steps/3"), "frame")[0];
  const body = box(svg, "/root/steps/3/body");
  assert.ok(frame, "a map is a frame");
  assert.ok(num(frame, "x") < num(body, "x") && num(frame, "x") + num(frame, "width") > num(body, "x") + num(body, "width"), "around its body");
  assert.ok(num(frame, "y") < num(body, "y") && num(frame, "y") + num(frame, "height") > num(body, "y") + num(body, "height"));

  assert.deepEqual(words(svg, "label"), ["Find the filings", "Kind of company", "Read the 10-K", "Is it registered", "Each officer", "Screen the officer", "Write the brief"]);
  assert.ok(words(group(svg, "/root/steps/2/branches/public/body"), "kind")[0].includes("http"), "a call names its transport");
  assert.ok(has(group(svg, "/root/steps/0"), "who-agent") && has(group(svg, `${PRIVATE}/steps/0`), "who-jev") && has(group(svg, "/root/steps/2/branches/public/body"), "who-tool"), "coloured by who works");
  for (const path of CARDS) {
    const [card, swatch, label] = [box(svg, path), inside(group(svg, path), "swatch")[0], inside(group(svg, path), "label")[0]];
    assert.deepEqual([num(swatch, "width"), num(swatch, "height")], [8, 8], `${path}: who works is a small square, not a bar down the card's edge`);
    assert.ok(num(swatch, "x") > num(card, "x") && num(swatch, "y") > num(card, "y") && num(swatch, "y") + 8 < num(card, "y") + num(card, "height"), "inside the card");
    assert.ok(num(label, "x") > num(swatch, "x") + 8, "the label clears it");
  }
  for (const el of groups(svg)) assert.ok(titleOf(el), `${el.getAttribute("data-path")} has a title`);
  assert.equal(groups(svg).filter((el) => stateOf(el).length || has(el, "new") || has(el, "edited")).length, 0, "no marks, no state");
});

test("every kind's card shows who works with a square inside it, never a bar down its edge", () => {
  const kinds = ["agent", "decide", "extract", "report", "artifact", "judge", "pick", "sift", "route", "call", "code", "chain", "parallel", "map", "loop", "workflow"];
  const { draw } = mount();
  const svg = draw({ nodes: [node("/root", "chain"), ...kinds.map((kind, i) => node(`/root/steps/${i}`, kind, `A ${kind}`))], edges: [] });
  const cards = groups(svg).filter((el) => has(el, "card"));
  assert.equal(cards.length, kinds.length);
  const who = new Set();
  for (const card of cards) {
    const [outline] = inside(card, "box");
    const rects = all(card).filter((el) => el.tagName === "rect" && el !== outline);
    assert.deepEqual(rects.map((el) => classes(el)), [["swatch"]], `${card.getAttribute("data-path")}: one swatch`);
    assert.ok(!rects.some((el) => num(el, "x") === num(outline, "x") && num(el, "height") >= num(outline, "height")), "no rect runs down the card's left edge");
    who.add(classes(card).find((name) => name.startsWith("who-")));
  }
  assert.deepEqual([...who].sort(), ["who-agent", "who-code", "who-control", "who-jev", "who-tool"], "a swatch for each who-works class");
});

test("a diff: NEW and EDITED tags on their nodes, the exit's beside its pill, the removed nodes listed as text, and a redraw clears them", () => {
  const { draw } = mount();
  const plain = all(draw(GRAPH)).length;
  const svg = draw(GRAPH, { diff: { added: ["/root/steps/1", "/root/steps/3/body"], edited: ["/root/steps/0"], removed: [{ label: "Check the registry", kind: "judge" }, { label: "Old brief", kind: "report" }] } });
  const tagged = Object.fromEntries(groups(svg).filter((el) => words(el, "tag").length).map((el) => [el.getAttribute("data-path"), words(el, "tag")]));
  assert.deepEqual(tagged, { "/root/steps/0": ["EDITED"], "/root/steps/1": ["NEW"], "/root/steps/3/body": ["NEW"] }, "a word on each, never a colour alone");
  assert.ok(has(group(svg, "/root/steps/1"), "new") && has(group(svg, "/root/steps/0"), "edited") && !has(group(svg, "/root/steps/2"), "new"));
  for (const path of Object.keys(tagged)) assert.equal(inside(group(svg, path), "tag-box").length, 1, `${path}: the tag is a box with its word`);
  const pill = inside(group(svg, "/root/steps/1"), "exit-box")[0];
  assert.ok(num(inside(group(svg, "/root/steps/1"), "tag-box")[0], "x") >= num(pill, "x") + num(pill, "width"), "an exit's tag sits to its pill's right");
  const card = box(svg, "/root/steps/0");
  const tag = inside(group(svg, "/root/steps/0"), "tag-box")[0];
  assert.ok(num(tag, "x") + num(tag, "width") <= num(card, "x") + num(card, "width") && num(tag, "y") < num(card, "y"), "a card's tag sits on its top edge");
  assert.deepEqual(words(svg, "removed"), ["Removed:", "Check the registry (judge)", "Old brief (report)"], "one line each");
  for (const text of inside(svg, "removed")) assert.ok(num(text, "y") > Math.max(...inside(svg, "box").map((el) => num(el, "y") + num(el, "height"))), "under the graph");
  assert.equal(groups(svg).length, GRAPH.nodes.length, "a removed node is not drawn: it is not in the graph");

  const again = draw(GRAPH);
  assert.equal(all(again).length, plain, "a redraw on the same svg clears the last one first");
  assert.deepEqual([words(again, "tag"), words(again, "removed")], [[], []]);
});

test("a run's state: one class per node, the fired exit escalated though its state says not-run and marked fired, escalated never failed, the taken branch marked", () => {
  const { draw } = mount();
  const status = {
    "/root": "escalated", "/root/steps/0": "done", "/root/steps/1": "done", "/root/steps/2": "escalated",
    "/root/steps/2/branches/public/body": "not-run", [PRIVATE]: "escalated", [`${PRIVATE}/steps/0`]: "done", [FIRED]: "not-run",
    "/root/steps/3": "not-run", "/root/steps/3/body": "not-run", "/root/steps/4": "not-run",
  };
  const svg = draw(GRAPH, { status, fired: FIRED, taken: [PRIVATE] });
  const drawn = Object.fromEntries(groups(svg).map((el) => [el.getAttribute("data-path"), stateOf(el)]));
  assert.deepEqual(drawn, Object.fromEntries(Object.entries(status).map(([path, state]) => [path, [path === FIRED ? "escalated" : state]])));
  const fired = group(svg, FIRED);
  assert.match(titleOf(fired), /escalated/, "its title says so");
  assert.deepEqual(words(fired, "state"), ["escalated"], "and so does a word beside it");
  assert.ok(!has(fired, "failed") && !has(fired, "not-run"));
  assert.deepEqual(groups(svg).filter((el) => has(el, "fired")).map((el) => el.getAttribute("data-path")), [FIRED], "only the exit that fired is fired");
  assert.deepEqual(words(group(svg, "/root/steps/0"), "state"), ["done"]);
  assert.deepEqual(words(group(svg, "/root/steps/4"), "state"), [], "a node not run is faded, with no word");
  assert.match(titleOf(group(svg, "/root/steps/4")), /not run/);
  const branches = inside(group(svg, "/root/steps/2"), "branch");
  assert.deepEqual(branches.map((el) => has(el, "taken")), [false, true], "the branch the run took");

  const failed = draw(GRAPH, {
    status: { "/root": "failed", "/root/steps/0": "done", "/root/steps/1": "skipped", "/root/steps/2": "failed", "/root/steps/2/branches/public/body": "failed", "/root/steps/3": "working", "/root/steps/3/body": "x\" onclick=\"alert(1)", "/root/steps/4": "constructor" },
  });
  const states = Object.fromEntries(groups(failed).map((el) => [el.getAttribute("data-path"), stateOf(el)]));
  assert.deepEqual(states, {
    "/root": ["failed"], "/root/steps/0": ["done"], "/root/steps/1": [], "/root/steps/2": ["failed"], "/root/steps/2/branches/public/body": ["failed"],
    [PRIVATE]: [], [`${PRIVATE}/steps/0`]: [], [FIRED]: [], "/root/steps/3": ["working"], "/root/steps/3/body": [], "/root/steps/4": [],
  }, "a state the drawer does not know, skipped among them, adds nothing");
  assert.deepEqual(words(group(failed, "/root/steps/2/branches/public/body"), "state"), ["failed"]);
  assert.deepEqual(words(group(failed, "/root/steps/3"), "state"), ["working"]);
  for (const el of groups(failed)) assert.deepEqual(classes(el).filter((name) => /onclick|constructor|"/.test(name)), [], "no class from a state's text");
  for (const el of [...groups(svg), ...groups(failed)]) assert.ok(!(has(el, "escalated") && has(el, "failed")), "escalated is never failed");
});

test("a stopped node: its own class and the word stopped, drawn neutral, never as failed, escalated or working", () => {
  const { draw } = mount();
  const svg = draw(GRAPH, { status: { "/root": "stopped", "/root/steps/0": "stopped", "/root/steps/1": "not-run" } });
  const stopped = group(svg, "/root/steps/0");
  assert.deepEqual(stateOf(stopped), ["stopped"]);
  assert.deepEqual(words(stopped, "state"), ["stopped"], "a word beside it, as every state has");
  assert.match(titleOf(stopped), /stopped/);
  const rule = (selector) => PAGE_CSS.match(new RegExp(`${selector.replace(/[.>]/g, "\\$&")}[^{]*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule(".wf .stopped>.box"), /stroke:var\(--muted\)/, "a neutral line");
  assert.match(rule(".wf .stopped>.state"), /fill:var\(--muted\)/);
  assert.doesNotMatch(rule(".wf .stopped>.box") + rule(".wf .stopped>.state"), /--red|--exit|--accent|--green/);
});

test("a container on the escalation's path: escalated with a light look of its own, the exit that fired inside it filled", () => {
  const BODY = "/root/steps/1/body";
  const EXIT = `${BODY}/steps/1`;
  const graph = {
    nodes: [node("/root", "chain"), node("/root/steps/0", "agent", "List the officers"), node("/root/steps/1", "map", "Each officer"), node(BODY, "chain"), node(`${BODY}/steps/0`, "agent", "Screen the officer"), node(EXIT, "escalate", "sanctioned"), node("/root/steps/2", "report", "Write the brief")],
    edges: [{ from: "/root", to: "/root/steps/0", kind: "next" }, { from: "/root/steps/0", to: "/root/steps/1", kind: "next" }, { from: "/root/steps/1", to: BODY, kind: "item" }, { from: BODY, to: `${BODY}/steps/0`, kind: "next" }, { from: `${BODY}/steps/0`, to: EXIT, kind: "next" }, { from: "/root/steps/1", to: "/root/steps/2", kind: "next" }],
  };
  const { draw } = mount();
  const svg = draw(graph, { status: { "/root": "escalated", "/root/steps/0": "done", "/root/steps/1": "escalated", [BODY]: "escalated", [`${BODY}/steps/0`]: "done", [EXIT]: "escalated", "/root/steps/2": "not-run" }, fired: EXIT });
  const map = group(svg, "/root/steps/1");
  const exit = group(svg, EXIT);
  assert.deepEqual([stateOf(map), has(map, "fired"), has(map, "failed")], [["escalated"], false, false], "the map is on the path, not the exit that fired");
  assert.deepEqual(words(map, "state"), ["escalated"]);
  assert.deepEqual([stateOf(exit), has(exit, "fired")], [["escalated"], true]);
  const rule = (selector) => new RegExp(`(^|[},])${selector.replace(/[.>]/g, "\\$&")}[,{][^}]*`, "m").exec(PAGE_CSS)?.[0] ?? "";
  assert.match(rule(".wf .escalated>.box"), /stroke:var\(--exit\)/, "a container on the path is outlined in the exit colour");
  assert.doesNotMatch(rule(".wf .escalated>.box"), /fill|--red/, "not filled, and never the failed look");
  assert.match(rule(".wf .fired>.exit-box"), /fill:var\(--exit\)/, "the exit that fired is filled");
});

test("labels, branch names, a transport and removed nodes with markup are text: no element is made from them", () => {
  const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const graph = {
    nodes: [
      node("/root", "chain"),
      node("/root/steps/0", "agent", `Read ${HOSTILE}`),
      node("/root/steps/1", "escalate", HOSTILE),
      node("/root/steps/2", "route", `<b onclick=x>route</b>`),
      node("/root/steps/2/branches/a~1b <i>x<~1i>/body", "call", `Fetch ${HOSTILE}`, `<svg onload=alert(3)>`),
      node("/root/steps/2/branches/~0no/body", "code", HOSTILE),
    ],
    edges: [],
  };
  const { draw } = mount();
  const svg = draw(graph, { diff: { added: ["/root/steps/1"], edited: [], removed: [{ label: HOSTILE, kind: "<i>judge</i>" }] }, status: { "/root/steps/0": "done" } });
  assert.equal(groups(svg).length, graph.nodes.length);
  for (const el of all(svg)) {
    assert.equal(el.namespaceURI, SVG);
    assert.ok(SHAPES.includes(el.tagName), `no ${el.tagName} element`);
    for (const [name] of el.attributes) assert.ok(!/^on|^style$|href$|^src/i.test(name), `no ${name} attribute`);
  }
  assert.deepEqual(words(group(svg, "/root/steps/2"), "branch-name"), ["a/b <i>x</i>", "~no"], "a branch's name, unescaped from its pointer, as text");
  assert.equal(titleOf(group(svg, "/root/steps/0")), `Read ${HOSTILE} (agent): done`, "the whole label in the title");
  assert.ok(words(group(svg, "/root/steps/0"), "label")[0].startsWith("Read <img src=x"), "the card's label is the text, clipped to the card");
  assert.ok(titleOf(group(svg, "/root/steps/2/branches/a~1b <i>x<~1i>/body")).includes("<svg onload=alert(3)>"));
  assert.ok(words(svg, "removed")[1].startsWith(HOSTILE.slice(0, 20)), "a removed node's label is text");
  assert.ok(all(svg).some((el) => el.tagName === "title" && el.textContent.includes(`${HOSTILE} (<i>judge</i>)`)), "a removed node's whole label is in a title");
});

test("square corners: no rx or ry on any shape, and page.css rounds nothing", () => {
  const { draw } = mount();
  const drawn = [
    draw(GRAPH),
    draw(GRAPH, { diff: { added: GRAPH.nodes.map((n) => n.path), edited: [], removed: [{ label: "x", kind: "agent" }] } }),
    draw(GRAPH, { status: Object.fromEntries(GRAPH.nodes.map((n, i) => [n.path, STATES[i % STATES.length]])), fired: FIRED, taken: [PRIVATE] }),
  ];
  for (const svg of drawn) for (const el of all(svg)) assert.ok(!el.attributes.has("rx") && !el.attributes.has("ry"), `${el.tagName} has no rx or ry`);
  assert.deepEqual([...PAGE_CSS.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map((m) => m[1]), ["0!important"], "the one border-radius is the square-corners rule");
  assert.doesNotMatch(PAGE_CSS, /(^|[{;\s])r[xy]\s*:/, "no rx or ry in the CSS");
});

test("drawn at its natural size: the width is the drawing's own, set as an attribute, shrunk to fit down to 480 or its own width, never grown", () => {
  const { draw, svg } = mount();
  const sizeOf = (el) => {
    const [x, y, w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    assert.deepEqual([x, y, num(el, "width"), num(el, "height")], [0, 0, w, h], "the width and height are the viewBox's");
    return { w, h };
  };
  draw(GRAPH);
  const full = sizeOf(svg);
  const shapes = all(svg).filter((el) => el.tagName === "rect");
  const left = Math.min(...shapes.map((el) => num(el, "x")));
  const right = Math.max(...shapes.map((el) => num(el, "x") + num(el, "width")));
  const lines = all(svg).filter((el) => el.tagName === "line").flatMap((el) => [num(el, "x1"), num(el, "x2")]);
  assert.ok(lines.every((x) => x >= left && x <= right), "every wire is within the shapes");
  assert.equal(full.w - right, left, "as wide as the drawing and its margin, no wider");
  assert.ok(full.h > 0 && Number.isInteger(full.w) && Number.isInteger(full.h));
  assert.equal(svg.getAttribute("style"), null, "no style attribute");
  assert.ok(full.w > 480);
  assert.deepEqual(svg.styles, { "min-width": "480px" }, "a phone keeps it at least 480 wide, and its box scrolls it sideways");

  draw({ nodes: [node("/root", "agent", "Only")], edges: [] });
  const one = sizeOf(svg);
  assert.ok(one.w < full.w && one.h < full.h, "a smaller graph is a smaller svg: nothing is stretched to a fixed size");
  assert.ok(one.w < 480);
  assert.deepEqual(svg.styles, { "min-width": `${one.w}px` }, "a graph narrower than 480 is never held wider than it is");
  const removed = draw({ nodes: [node("/root", "agent", "Only")], edges: [] }, { diff: { added: [], edited: [], removed: Array.from({ length: 12 }, (_, i) => ({ label: `Removed step ${i}`, kind: "agent" })) } });
  const listed = sizeOf(removed);
  for (const text of inside(removed, "removed")) assert.ok(text.textContent.length * 11 * 0.6 <= listed.w, "the removed list wraps within the drawing");
  assert.ok(inside(removed, "removed").length > 1);

  const rule = /svg\.wf\{([^}]*)\}/.exec(PAGE_CSS);
  assert.ok(rule, "page.css styles svg.wf");
  assert.match(rule[1], /max-width:100%/);
  assert.match(rule[1], /height:auto/);
  assert.doesNotMatch(rule[1], /(^|;)\s*(min-)?width\s*:/, "no width but its own: it is never scaled up");
  assert.match(PAGE_CSS, /\.graph-box\{overflow-x:auto[;}]/, "the box page.js puts it in scrolls it, never the page");

  for (const bad of [null, undefined, {}, { nodes: "x" }, { nodes: [{ path: 3 }] }, { nodes: [node("/elsewhere", "agent")] }]) {
    assert.doesNotThrow(() => draw(bad, { status: null, diff: { added: "x" } }), JSON.stringify(bad));
    assert.equal(groups(svg).length, 0, "a graph with no root draws nothing");
  }
});
