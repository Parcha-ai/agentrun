// A small DOM for running the serve page's script offline: what page.js uses, and HTML sinks that throw. `mount` runs
// the script over a fake API (or a fetch of the caller's), with timers run by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const served = (name) => readFileSync(new URL(`../src/serve/${name}`, import.meta.url), "utf8");

export class Node {
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
export class Text extends Node {
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
export class Element extends Node {
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
  /** The first element under this one with the class `.name` names: the one selector the page uses. */
  querySelector(selector) {
    return all(this).find((node) => (node.getAttribute("class") ?? "").split(" ").includes(selector.slice(1))) ?? null;
  }
  scrollIntoView(options) {
    this.scrolledIntoView = options;
  }
}
for (const name of ["innerHTML", "outerHTML"]) Object.defineProperty(Element.prototype, name, { get: sink(name), set: sink(name) });
Element.prototype.insertAdjacentHTML = sink("insertAdjacentHTML");

export const all = (node) => node.childNodes.flatMap((kid) => (kid instanceof Element ? [kid, ...all(kid)] : []));

/** The page's document and window, its fetch answering from `api` (path to body, or [status, body]) or `options.fetch`,
 *  and timers run by hand. `options.serve` is the page's <html data-serve>: the store's page loads graph.js before
 *  page.js, as store.html does. `options.window` adds to its window after graph.js. */
export function mount(api, hash = "#/", options = {}) {
  const byId = {};
  const documentElement = new Element("html");
  if (options.serve) documentElement.setAttribute("data-serve", options.serve);
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
    createElementNS: (ns, tag) => Object.assign(new Element(tag), { namespaceURI: ns, tagName: tag }),
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
  const fetch = options.fetch ? async (path) => (fetched.push(path), options.fetch(path)) : async (path) => {
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
  if (options.serve === "store") vm.runInContext(served("graph.js"), context, { filename: "graph.js" });
  Object.assign(window, options.window);
  vm.runInContext(served("page.js"), context, { filename: "page.js" });
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
export function assertInert(node, allowed = []) {
  for (const el of all(node)) {
    if (allowed.includes(el)) continue;
    assert.ok(!["SCRIPT", "IMG", "SVG", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK", "META", "BASE", "FORM", "INPUT"].includes(el.tagName.toUpperCase()), `no ${el.tagName} element`);
    for (const [name, value] of el.attributes) {
      assert.ok(!name.startsWith("on") && name !== "style" && name !== "srcdoc" && name !== "src", `no ${name} attribute`);
      if (name === "href") assert.match(value, /^(#|https?:\/\/)/, `href ${value}`);
    }
  }
}
