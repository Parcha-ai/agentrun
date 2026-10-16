// A small DOM for the run page's tests: elements, text, attributes, events, a window with a hash route and timers.
// Enough for run-page.js, which builds its own markup and keeps its own references; nothing renders. `fetch` on the
// window throws, so a page that reads anything but its source fails the test.

class Text {
  constructor(text) {
    this.parent = null;
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
}

class Element {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.parent = null;
    this.children = [];
    this.nodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = [];
    this.html = null;
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(on) {
    if (on) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(on) {
    if (on) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get open() {
    return this.hasAttribute("open");
  }
  append(...kids) {
    for (const kid of kids) {
      const node = typeof kid === "string" || typeof kid === "number" ? new Text(kid) : kid;
      node.parent = this;
      this.nodes.push(node);
      if (node instanceof Element) this.children.push(node);
    }
    this.html = null;
  }
  replaceChildren(...kids) {
    const document = this.ownerDocument;
    const kept = new Set(kids);
    for (const old of this.nodes) {
      if (kept.has(old) || !document.activeElement) continue;
      for (let n = document.activeElement; n; n = n.parent) if (n === old) document.activeElement = null;
    }
    this.nodes = [];
    this.children = [];
    this.append(...kids);
  }
  get textContent() {
    return this.html !== null ? this.html.replace(/<[^>]*>/g, "") : this.nodes.map((n) => n.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(String(text));
  }
  set innerHTML(html) {
    this.replaceChildren();
    this.html = String(html);
  }
  get innerHTML() {
    return this.html ?? "";
  }
  addEventListener(type, fn) {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (let node = this; node; node = node.parent) for (const { type, fn } of node.listeners) if (type === event.type) fn(event);
  }
  /** The document's focus: set here, and dropped when the element leaves the page, as a browser drops it. */
  focus() {
    this.ownerDocument.activeElement = this;
  }
  click() {
    this.dispatchEvent({ type: "click", preventDefault() {} });
  }
  /** Every element under this one, depth first. */
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

/** A document and its window; `hash` is where the page starts. */
export function fakeDom({ hash = "#/" } = {}) {
  const listeners = [];
  const timers = new Set();
  const intervals = new Set();
  const objectUrls = new Map();
  let made = 0;
  const window = {
    location: { hash, href: `http://page.test/run/${hash}` },
    fetched: [],
    fetch(url) {
      window.fetched.push(String(url));
      throw new Error("the run page reads only through its source");
    },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => listeners.splice(listeners.findIndex((l) => l.type === type && l.fn === fn) >>> 0, 1),
    navigate(next) {
      window.location.hash = next;
      for (const { type, fn } of [...listeners]) if (type === "hashchange") fn({ type });
    },
    setTimeout: (fn, ms) => {
      const t = setTimeout(() => (timers.delete(t), fn()), ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => (clearTimeout(t), timers.delete(t)),
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      intervals.add(t);
      return t;
    },
    clearInterval: (t) => (clearInterval(t), intervals.delete(t)),
    requestAnimationFrame: (fn) => window.setTimeout(fn, 0),
    URL: {
      createObjectURL: (blob) => {
        const url = `blob:page.test/${(made += 1)}`;
        objectUrls.set(url, blob);
        return url;
      },
      revokeObjectURL: (url) => objectUrls.delete(url),
    },
    /** The Blob an object URL the page made still stands for. */
    blobOf: (url) => objectUrls.get(url),
    /** Timers and intervals still set: an unmounted page leaves none. */
    pending: () => timers.size + intervals.size,
    hashListeners: () => listeners.filter((l) => l.type === "hashchange").length,
  };
  const document = { defaultView: window, activeElement: null, createElement: (tag) => new Element(document, tag) };
  return { document, window, root: document.createElement("div") };
}

/** The first element under `root` with this id, or null. */
export const byId = (root, id) => [...root.walk()].find((e) => e.id === id) ?? null;
/** Every element under `root` with this tag (lower case). */
export const byTag = (root, tag) => [...root.walk()].filter((e) => e.tagName === tag.toUpperCase());
/** An element is on the page when it and every element above it are not hidden. */
export const shown = (node) => {
  for (let n = node; n; n = n.parent) if (n.hidden) return false;
  return true;
};
/** Let the page's promises and zero-delay timers run. */
export const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
