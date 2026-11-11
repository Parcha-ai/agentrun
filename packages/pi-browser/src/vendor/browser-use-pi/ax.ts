// Adapted from Browser Use Pi (https://github.com/browser-use/browser-use-pi) at commit
// e7007f219b10fa2c2baae1bf3e2f902a5a2706fd, src/ax.ts. MIT License, Copyright (c) 2026 Browser Use contributors; the
// license's full text is in this package's NOTICE, and UPSTREAM.json beside this file records the source.
// Changes: the page's ids are this package's "frame-node" strings (the frame's place in the snapshot, then Chrome's
// backendDOMNodeId), kept per snapshot so an action names only an id the latest snapshot showed; a snapshot names the
// cross-origin frames it could not read instead of skipping them silently; Pi's `type` (which replaces a field's text and
// also picks a native select's option) is split into fill, type (appending) and select, beside hover and press; actions
// return their one line instead of printing it; no REPL prompt, no hidden file-input listing and no file chooser; type
// appends after the field's whole text (not End, which stops at a line's end) and paces its characters by a delay; press
// takes modifier combinations (Shift+Tab, Control+A). The
// AX-id scheme, the POINT_JS hit-test (point), scroll then centre, press and release click, insertText plus a real last
// key, the settle wait and the one-line change result are Pi's.
import { setTimeout as delay } from "node:timers/promises";
import type { CDP } from "./cdp.js";
import type { Page } from "./page.js";

/** An accessibility node as Chrome reports it; only what is read here. */
type AX = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
};
type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
type Probe = { idle: number; ready: string; url: string; title: string; n: number; doc: number };

const CONTROLS = new Set("button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton tab menuitem menuitemcheckbox menuitemradio treeitem".split(" "));
/** Text inside these is one line; text across them is not joined. */
const BLOCKS = new Set(["paragraph", "listitem", "row", "LabelText"]);
const NATIVE_INPUTS = new Set(["Date", "DateTime", "InputTime"]);
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const prop = (n: AX, name: string) => n.properties?.find((p) => p.name === name)?.value.value;
const isContextLoss = (e: unknown) =>
  /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated|Target closed|No frame/.test(String(e instanceof Error ? e.message : e));

/** The keys `press` sends by name, with their virtual key codes; any other single character is typed as itself. */
const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};
/** CDP's modifier bits, by the names a press takes before its key. */
const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;
const MODIFIERS: Record<string, number> = { alt: ALT, control: CONTROL, ctrl: CONTROL, meta: META, command: META, cmd: META, shift: SHIFT };
/** A press's key: modifiers, each followed by "+", then the key itself (which may be "+"). */
const KEY_COMBO = /^((?:(?:shift|control|ctrl|alt|meta|command|cmd)\+)*)(.+)$/i;
/** The editing command Chrome runs for a shortcut's letter (headless Chrome binds none of them to the keys itself). */
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/** A snapshot id is stale or never was: the driver turns it into the package's own words. */
export class UnknownIdError extends Error {
  constructor(readonly id: string) {
    super(`unknown snapshot id ${id}`);
    this.name = "UnknownIdError";
  }
}

/** Snapshot and id-based actions on Chrome's accessibility tree. */
export class AxHelpers {
  constructor(
    private page: () => Page,
    private browser: () => CDP,
  ) {}

  private inflight = new Map<string, Map<string, number>>();
  private lastNet = new Map<string, number>();
  private tracked = new Set<string>();
  private dialogs: string[] = [];
  private observing = false;
  /** Role and name of every backend id in the last snapshot: marks new ids and names targets in action lines. */
  private last = new Map<number, { role: string; name: string }>();
  /** The last snapshot's displayed ids, each to its backend node id; none before the first snapshot or after forget(). */
  private ids: Map<string, number> | undefined;
  /** The document and address the last snapshot was taken on. */
  taken: { doc: number; url: string } | undefined;

  /** Track in-flight requests per page session from CDP Network events (no page patching), and accept dialogs. */
  private async trackNetwork(page: Page) {
    const cdp = this.browser();
    if (!this.observing) {
      const previous = cdp.observeEvent;
      cdp.observeEvent = (method, raw, session) => {
        previous?.(method, raw, session);
        // An open alert/confirm blocks the page and every CDP call on it: accept it and report its text.
        if (method === "Page.javascriptDialogOpening") {
          const d = raw as { type: string; message: string; defaultPrompt?: string };
          this.dialogs.push(`[dialog ${d.type}] ${JSON.stringify(clip(d.message, 300))} (accepted)`);
          void cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: d.defaultPrompt ?? "" }, session).catch(() => {});
          return;
        }
        if (method === "Target.detachedFromTarget") {
          const gone = (raw as { sessionId: string }).sessionId;
          this.inflight.delete(gone);
          this.lastNet.delete(gone);
          this.tracked.delete(gone);
          return;
        }
        if (!session || !method.startsWith("Network.")) return;
        const params = raw as { requestId: string; type?: string };
        const map = this.inflight.get(session) ?? new Map<string, number>();
        this.inflight.set(session, map);
        if (method === "Network.requestWillBeSent") {
          if (!["WebSocket", "EventSource", "Media", "Ping", "Manifest"].includes(params.type ?? "")) map.set(params.requestId, Date.now());
        } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") map.delete(params.requestId);
        else return;
        this.lastNet.set(session, Date.now());
      };
      this.observing = true;
    }
    const session = page.sessionId;
    if (session && !this.tracked.has(session)) {
      this.tracked.add(session);
      await page.cdp("Network.enable", {}).catch(() => this.tracked.delete(session));
    }
    return session;
  }

  /** URL, title, document identity, a counter of DOM mutations (style aside) and form input/change events. */
  probe(page: Page = this.page()): Promise<Probe> {
    return page.evaluate(() => {
      const w = window as unknown as { __buObs?: MutationObserver; __buLast: number; __buN: number; __buDoc: number };
      if (!w.__buObs) {
        w.__buLast = performance.now();
        w.__buN = 0;
        w.__buDoc = Math.random();
        // A style change counts only as the first on its element in 200 ms: a menu shown via style.display is a change, an
        // animation loop goes quiet.
        const styled = new WeakMap<Node, number>();
        w.__buObs = new MutationObserver((records) => {
          const now = performance.now();
          let real = false;
          for (const r of records) {
            // Writing an attribute's current value changes nothing (Google Flights rewrites a class every frame).
            if (r.attributeName && r.oldValue === (r.target as Element).getAttributeNS(r.attributeNamespace, r.attributeName)) continue;
            if (r.attributeName !== "style") real = true;
            else if (now - (styled.get(r.target) ?? -1e9) > 200) real = true;
            if (r.attributeName === "style") styled.set(r.target, now);
          }
          if (real) {
            w.__buLast = now;
            w.__buN++;
          }
        });
        w.__buObs.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
        for (const type of ["input", "change"]) addEventListener(type, () => w.__buN++, true);
      }
      return { idle: performance.now() - w.__buLast, ready: document.readyState, url: location.href, title: document.title, n: w.__buN, doc: w.__buDoc };
    });
  }

  /**
   * Event-based wait, never a fixed sleep: document parsed, no fresh in-flight requests (older than 1.5 s are treated as
   * long-poll/analytics), and no DOM mutation for quietMs. Bounded by capMs.
   */
  async settle(options: { capMs?: number; quietMs?: number; page?: Page; since?: number } = {}) {
    const page = options.page ?? this.page();
    const cap = options.capMs ?? 800;
    const quiet = options.quietMs ?? 80;
    const start = Date.now();
    const session = await this.trackNetwork(page).catch(() => undefined);
    let limit = cap;
    let pending = 0;
    let probe: Probe | undefined;
    const inflight = () => (session ? [...(this.inflight.get(session)?.values() ?? [])].filter((t) => Date.now() - t < 1500).length : 0);
    const netBusy = () => (pending = inflight()) > 0 || (session ? Date.now() - (this.lastNet.get(session) ?? 0) : quiet) < quiet;
    while (Date.now() - start < limit) {
      try {
        probe = await this.probe(page);
        if (probe.ready === "loading") limit = Math.max(cap, 3000); // navigations need longer than in-page updates
        probe.idle = Math.min(probe.idle, Date.now() - (options.since || start)); // quiet must be observed after this action began
        if (probe.ready !== "loading" && probe.idle >= quiet && !netBusy()) return { why: "quiet", pending, ms: Date.now() - start, probe };
      } catch (error) {
        // Navigation in progress: wait for the new document. Anything else ends the wait, never the action.
        if (!isContextLoss(error)) return { why: "error", pending, ms: Date.now() - start };
        probe = undefined;
      }
      // Probe again once the DOM can have been quiet for quietMs; wait out in-flight requests here, not in the page.
      await delay(probe && probe.ready !== "loading" ? Math.max(20, quiet - probe.idle) : 40);
      while (probe && probe.idle >= quiet && netBusy() && Date.now() - start < limit) await delay(20);
    }
    return { why: "cap", pending: inflight(), ms: Date.now() - start };
  }

  private flushDialogs() {
    return this.dialogs.length ? `\n${this.dialogs.splice(0).join("\n")}` : "";
  }

  /**
   * Text actually shown, lowercased with whitespace collapsed. The AX tree keeps opacity:0 text (pre-rendered success
   * banners), which agents then report as success; checkVisibility with checkOpacity drops it.
   */
  private visibleText(page = this.page()) {
    return page.evaluate(() => {
      const out: string[] = [];
      const shown = new Map<Element, boolean>();
      const roots: Node[] = [document];
      for (let i = 0; i < roots.length; i++) {
        const walk = document.createTreeWalker(roots[i]!, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const el = n as Element & { contentDocument?: Document | null };
            if (el.shadowRoot) roots.push(el.shadowRoot);
            if (el.contentDocument) roots.push(el.contentDocument); // same-origin iframe
            continue;
          }
          let e = n.parentElement;
          if (!e || !n.textContent?.trim()) continue;
          // display:contents has no box, so checkVisibility is false; its text shows through the nearest boxed ancestor.
          while (e.parentElement && getComputedStyle(e).display === "contents") e = e.parentElement;
          if (!shown.has(e)) shown.set(e, e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
          if (shown.get(e)) out.push(n.textContent);
        }
      }
      return out.join(" ").replace(/\s+/g, " ").toLowerCase();
    });
  }

  /**
   * AX trees of the main frame and, with `frames`, of every same-process child frame. A child frame whose tree cannot be
   * read (a cross-origin frame Chrome runs in another process) is returned as `unread`, never dropped unsaid.
   */
  private async capture(page: Page, frames: boolean) {
    for (let i = 0; ; i++) {
      try {
        const [{ nodes }, { frameTree }] = await Promise.all([page.cdp<{ nodes: AX[] }>("Accessibility.getFullAXTree"), page.cdp<{ frameTree: FrameTree }>("Page.getFrameTree")]);
        const children: { url: string; id: string }[] = [];
        const walk = (tree: FrameTree) =>
          tree.childFrames?.forEach((child) => {
            children.push({ url: child.frame.url, id: child.frame.id });
            walk(child);
          });
        walk(frameTree);
        if (!frames) return { frames: [{ url: "", nodes }], unread: [] as string[], skipped: children.length };
        const read = await Promise.all(
          children.map(({ url, id }) =>
            page.cdp<{ nodes: AX[] }>("Accessibility.getFullAXTree", { frameId: id }).then(
              (r) => ({ url, nodes: r.nodes, ok: true }),
              () => ({ url, nodes: [] as AX[], ok: false }),
            ),
          ),
        );
        // A cross-origin frame in a process of its own: Chrome lists it as a target of type iframe under this page's frames.
        const own = new Set([frameTree.frame.id, ...children.map((c) => c.id)]);
        const targets = await this.browser()
          .send<{ targetInfos: Array<{ type: string; url: string; parentFrameId?: string; targetId: string }> }>("Target.getTargets")
          .then((r) => r.targetInfos.filter((t) => t.type === "iframe" && t.parentFrameId !== undefined && own.has(t.parentFrameId)).map((t) => t.url), () => [] as string[]);
        const unread = [...new Set([...read.filter((f) => !f.ok).map((f) => f.url), ...targets])];
        return { frames: [{ url: "", nodes }, ...read.filter((f) => f.ok)], unread, skipped: 0 };
      } catch (error) {
        if (i >= 20 || !isContextLoss(error)) throw error;
        await delay(50);
      }
    }
  }

  /** The page as one list in page order: `[frame-node] role "name" = value states`, ## headings and visible text. */
  async snapshot(options: { includeIframes?: boolean; max?: number } = {}): Promise<string> {
    const page = this.page();
    const settled = await this.settle({ capMs: 3000 });
    const [captured, info, visible] = await Promise.all([this.capture(page, options.includeIframes !== false), settled.probe ?? this.probe(page), this.visibleText(page).catch(() => undefined)]);
    const previous = this.last;
    this.last = new Map();
    const ids = new Map<string, number>();
    const lines: string[] = [];
    const text: string[] = [];
    const flush = () => text.length && lines.push(text.splice(0).join(" "));
    captured.frames.forEach((frame, place) => {
      const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
      const start = lines.length;
      const walk = (n: AX | undefined, inside: string): void => {
        if (!n) return;
        const role = String(n.role?.value ?? "");
        const name = norm(n.name?.value);
        const kids = () => n.childIds?.forEach((c) => walk(byId.get(c), inside));
        if (n.ignored) return kids();
        if (role === "StaticText") {
          const t = name.toLowerCase();
          if (t && !inside.includes(t) && (visible === undefined || visible.includes(t))) text.push(name);
          return;
        }
        if (role === "heading" && name) {
          flush();
          lines.push(`## ${name}`);
          inside = name.toLowerCase();
          return kids();
        }
        const id = n.backendDOMNodeId;
        // Focusable wrappers (tabindex=-1 dialogs, <main>) are only controls if they carry a name, value or editing.
        const focusable = prop(n, "focusable") && role !== "RootWebArea" && (name || n.value?.value || prop(n, "editable"));
        if (!id || !(CONTROLS.has(role) || focusable)) {
          if (!BLOCKS.has(role)) return kids();
          flush();
          kids();
          flush();
          return;
        }
        flush();
        if (lines.at(-1)?.toLowerCase() === name.toLowerCase()) lines.pop(); // its label, printed as its name
        const value = norm(n.value?.value);
        const checked = prop(n, "checked");
        const states = [
          checked === undefined ? "" : checked === "false" || checked === false ? "unchecked" : "checked",
          prop(n, "expanded") === undefined ? "" : prop(n, "expanded") ? "expanded" : "collapsed",
          ...["selected", "disabled", "focused"].map((p) => (prop(n, p) ? p : "")),
        ].filter(Boolean);
        // A native <select> keeps its options in a popup child: summarize them instead of listing each.
        const popup = n.childIds?.map((c) => byId.get(c)).find((c) => c?.role?.value === "MenuListPopup");
        const choices: string[] = [];
        const collect = (c?: AX): unknown => (c?.role?.value === "option" ? choices.push(norm(c.name?.value)) : c?.childIds?.forEach((k) => collect(byId.get(k))));
        collect(popup);
        const shown = popup ? "select" : role === "generic" && prop(n, "editable") ? "textbox" : role;
        const display = `${place}-${id}`;
        ids.set(display, id);
        this.last.set(id, { role: shown, name });
        lines.push(
          `${previous.size && !previous.has(id) ? "*" : ""}[${display}] ${shown}${name ? ` "${clip(name, 150)}"` : ""}${value ? ` = ${JSON.stringify(clip(value, 100))}` : ""}${states.length ? ` ${states.join(" ")}` : ""}${choices.length ? `  options: ${choices.slice(0, 5).join(" | ")}${choices.length > 5 ? ` | … ${choices.length - 5} more` : ""}` : ""}`,
        );
        if (popup || NATIVE_INPUTS.has(role)) return; // their children are the browser's own widget parts
        // Only what the line showed counts as said: a card link's text past the clipped name still prints.
        inside = `${inside} ${clip(name, 150)} ${value}`.toLowerCase();
        kids();
        flush();
      };
      walk(frame.nodes[0], "");
      flush();
      if (frame.url && lines.length > start) lines.splice(start, 0, `--- frame ${frame.url} ---`);
    });
    this.ids = ids;
    this.taken = { doc: info.doc, url: info.url };
    const notes = [
      ...captured.unread.map((url) => `(not in this snapshot: the cross-origin frame ${clip(url, 200)}; this browser reads no frame another site runs in its own process, so its elements have no ids here)`),
      ...(captured.skipped ? [`(${captured.skipped} ${captured.skipped === 1 ? "frame" : "frames"} left out: includeIframes is false)`] : []),
    ];
    const header = `[page] ${info.title} | ${info.url}${settled.pending ? ` | loading: ${settled.pending}` : ""}${this.flushDialogs()}`;
    const max = options.max ?? 20_000;
    const fit = (from: string[], budget: number) => {
      let size = 0;
      const n = from.findIndex((l) => (size += l.length + 1) > budget);
      return n < 0 ? from.length : n;
    };
    let body = lines;
    // Over max, keep the top and the last fifth: a dialog's Done/Submit is usually its last line.
    if (fit(lines, max) < lines.length) {
      const head = fit(lines, max * 0.8);
      const tail = fit(lines.toReversed(), max * 0.2);
      body = [...lines.slice(0, head), `... ${lines.length - head - tail} lines cut here`, ...lines.slice(lines.length - tail)];
    }
    return [header, ...body, ...notes].join("\n");
  }

  /** Drops the snapshot's ids: an action by any of them then fails as a stale snapshot. */
  forget() {
    this.ids = undefined;
    this.taken = undefined;
  }

  /** Whether there is a snapshot to act on. */
  get hydrated() {
    return this.ids !== undefined;
  }

  /** The backend node id a displayed id names in the latest snapshot; throws UnknownIdError for any other. */
  nodeOf(id: string): number {
    const node = this.ids?.get(id);
    if (node === undefined) throw new UnknownIdError(id);
    return node;
  }

  private async onNode<T>(page: Page, id: number, fn: string, argument?: unknown): Promise<T> {
    const { object } = await page.cdp<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: id });
    if (!object.objectId) throw new Error("Node unavailable.");
    try {
      const response = await page.cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: [{ value: argument }], returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error((response.exceptionDetails.exception?.description ?? "Node operation failed.").split("\n    at ")[0]);
      return response.result.value as T;
    } finally {
      await page.cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }

  private describe(display: string, id: number) {
    const n = this.last.get(id);
    return n ? `[${display}] ${n.role}${n.name ? ` "${clip(n.name, 60)}"` : ""}` : `[${display}]`;
  }

  /** Scroll into view and return a clickable, unobstructed center point, or throw a precise reason. */
  async point(page: Page, id: number, editableCover = false) {
    await page.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {});
    const p = await this.onNode<{ x: number; y: number; covered: boolean }>(
      page,
      id,
      `function(editableCover) {
        const e = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!e || !e.isConnected) throw Error('Target detached');
        if (e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]')) throw Error('Target disabled');
        if (e.matches('input[type=file]')) throw Error("File input: clicking opens the OS file chooser, which this browser does not offer");
        if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) throw Error('Target hidden');
        const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw Error('Target outside viewport');
        const hit = e.getRootNode().elementFromPoint(x, y);
        const textField = (n) => n && (['INPUT','TEXTAREA'].includes(n.tagName) || n.isContentEditable);
        const covered = !e.contains(hit) && !(hit && hit.contains(e) && getComputedStyle(hit).pointerEvents !== 'none' && hit.tagName === 'LABEL') && !(editableCover && textField(e) && textField(hit));
        // Inside same-origin iframes, add each frame's content-box offset to get top-level viewport coordinates.
        let px = x, py = y;
        for (let w = e.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
          const f = w.frameElement, fr = f.getBoundingClientRect(), cs = getComputedStyle(f);
          px += fr.x + f.clientLeft + parseFloat(cs.paddingLeft);
          py += fr.y + f.clientTop + parseFloat(cs.paddingTop);
        }
        return {x: px, y: py, covered};
      }`,
      editableCover,
    );
    if (!p.covered) return p;
    const hit = await page.cdp<{ backendNodeId: number }>("DOM.getNodeForLocation", { x: Math.round(p.x), y: Math.round(p.y) }).catch(() => undefined);
    const tree = hit ? await page.cdp<{ nodes: AX[] }>("Accessibility.getPartialAXTree", { backendNodeId: hit.backendNodeId }).catch(() => undefined) : undefined;
    // The node under the point and its ancestors: name the nearest one with a name or a dialog role.
    const byId = new Map(tree?.nodes.map((n) => [n.nodeId, n]));
    const top = tree?.nodes.find((a) => a.backendDOMNodeId === hit?.backendNodeId);
    let n = top;
    while (n && n.role?.value !== "RootWebArea" && (n.ignored || !(norm(n.name?.value) || /dialog/.test(String(n.role?.value))))) n = n.parentId ? byId.get(n.parentId) : undefined;
    // A nameless overlay: name it by its own text instead of the page it sits on.
    const text = (x?: AX) => norm(x?.name?.value) || norm(x?.childIds?.map((c) => byId.get(c)).find((c) => c?.role?.value === "StaticText")?.name?.value);
    if (!n || n.role?.value === "RootWebArea") n = top;
    throw new Error(`Target covered by ${n ? `${n.role?.value} "${clip(text(n), 60)}"` : "another element"}; nothing was clicked`);
  }

  /** Runs one action on a displayed id and returns one line: navigated to <url> / page changed / no change. */
  private async act(op: string, display: string, body: (page: Page, id: number) => Promise<string>) {
    const id = this.nodeOf(display);
    const page = this.page();
    await this.trackNetwork(page).catch(() => {});
    const before = await this.probe(page).catch(() => undefined);
    let detail: string;
    try {
      detail = await body(page, id);
    } catch (error) {
      throw new Error(`${op} ${this.describe(display, id)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const settled = await this.settle();
    return `[ok] ${op} ${this.describe(display, id)}${detail} -> ${await this.change(before, settled.probe)}${this.flushDialogs()}`;
  }

  async change(before: Probe | undefined, after?: Probe) {
    after ??= await this.probe(this.page()).catch(() => undefined);
    if (!before || !after) return "page changed";
    if (after.doc !== before.doc || after.url !== before.url) return `navigated to ${after.url}`;
    return after.n !== before.n ? "page changed" : "no change";
  }

  click(display: string) {
    return this.act("click", display, async (page, id) => {
      const p = await this.point(page, id);
      await page.clickAt(p.x, p.y);
      return "";
    });
  }

  hover(display: string) {
    return this.act("hover", display, async (page, id) => {
      const p = await this.point(page, id);
      await page.moveTo(p.x, p.y);
      return "";
    });
  }

  /** Picks a native select's option by its label or value, or each of several in a multiple select. */
  select(display: string, values: string | string[]) {
    const wanted = Array.isArray(values) ? values : [values];
    return this.act("select", display, async (page, id) => {
      const labels = await this.onNode<string[]>(
        page,
        id,
        `function(wanted){
          if (this.tagName !== 'SELECT') throw Error('not a select: click it and then the option instead');
          if (wanted.length > 1 && !this.multiple) throw Error('this select takes one option, not ' + wanted.length);
          const n = s => String(s).replace(/\\s+/g,' ').trim().toLowerCase(), opts = [...this.options].filter(o => !o.disabled);
          const picked = wanted.map(want => {
            const pre = opts.filter(o => n(o.label).startsWith(n(want)));
            const o = opts.find(o => n(o.label) === n(want) || n(o.value) === n(want)) ?? (pre.length === 1 ? pre[0] : undefined);
            if (!o) throw Error((pre.length > 1 ? 'several options start with ' : 'no option ') + JSON.stringify(want) + '. Options: ' + (pre.length > 1 ? pre : opts).slice(0, 40).map(o => o.label).join(' | '));
            return o;
          });
          if (this.multiple) for (const o of opts) o.selected = picked.includes(o); else this.value = picked[0].value;
          this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
          return picked.map(o => o.label);
        }`,
        wanted,
      );
      return ` = ${JSON.stringify(labels.length === 1 ? labels[0] : labels)}`;
    });
  }

  /** Replaces a field's text (Pi's type): a native date or time input by its value, any other by click, select-all and keys. */
  fill(display: string, text: string) {
    return this.act("fill", display, (page, id) => this.enter(page, id, text, true));
  }

  /** Types at the end of a field's whole text, as keys would; `delayMs` between characters, as paced typing asks. */
  type(display: string, text: string, delayMs?: number) {
    return this.act("type", display, (page, id) => this.enter(page, id, text, false, delayMs));
  }

  /** Clicks the element, then presses a key on it: a name (Enter, Tab, Escape, ArrowDown, ...) or one character, each
   *  with any of the modifiers Shift, Control (Ctrl), Alt and Meta (Command, Cmd) before it: Shift+Tab, Control+A. */
  press(display: string, key: string) {
    return this.act("press", display, async (page, id) => {
      const combo = KEY_COMBO.exec(key);
      const modifiers = (combo?.[1] ?? "").split("+").filter(Boolean).reduce((bits, name) => bits | MODIFIERS[name.toLowerCase()]!, 0);
      const base = combo?.[2] ?? key;
      const named = NAMED_KEYS[base];
      if (!named && [...base].length !== 1) throw new Error(`press takes one character or a key name (${Object.keys(NAMED_KEYS).join(", ")}), each with any of Shift+, Control+, Alt+ and Meta+ before it, not ${JSON.stringify(key)}`);
      const p = await this.point(page, id, true);
      await page.clickAt(p.x, p.y);
      if (named) await this.key(page, base, named.keyCode, modifiers & ~SHIFT ? undefined : named.text, modifiers, named.code);
      else {
        const upper = base.toUpperCase();
        const letter = /^[A-Z]$/.test(upper);
        const code = letter ? `Key${upper}` : /^[0-9]$/.test(base) ? `Digit${base}` : "";
        // A letter is its case as Shift makes it; a shortcut (Control, Alt or Meta) types nothing, and Chrome runs its
        // editing command (Control+A selects all).
        const name = letter ? (modifiers & SHIFT ? upper : base.toLowerCase()) : base;
        const command = modifiers & (CONTROL | META) ? EDIT_COMMANDS[base.toLowerCase()] : undefined;
        const text = modifiers & ~SHIFT ? undefined : name;
        const k = { key: name, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers };
        await page.cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...k, ...(text ? { text } : {}), ...(command ? { commands: [command] } : {}) });
        await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
      }
      return ` ${key}`;
    });
  }

  private async enter(page: Page, id: number, text: string, replace: boolean, delayMs = 0): Promise<string> {
    if (typeof text !== "string") throw new Error("the text must be a string.");
    const kind = await this.onNode<{ tag: string; type: string }>(
      page,
      id,
      `function(){const e=this.nodeType===1?this:this.parentElement;if(!e||!e.isConnected)throw Error('Target detached');return {tag:e.tagName,type:e.type||''};}`,
    );
    if (kind.tag === "SELECT") throw new Error('a select takes {"op":"select"} with the option, not text');
    if (replace && kind.tag === "INPUT" && ["date", "time", "datetime-local", "month", "week"].includes(kind.type)) {
      await this.onNode(
        page,
        id,
        `function(v){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set,old=this.value;s.call(this,v);if(this.value!==v){s.call(this,old);throw Error('Invalid native date/time value; use its ISO format');}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}`,
        text,
      );
      return ` = ${JSON.stringify(text)}`;
    }
    const p = await this.point(page, id, true);
    await page.clickAt(p.x, p.y);
    // Comboboxes often move focus to their own overlay input on click; type there, not into the hidden original.
    const moved = await this.onNode<boolean>(
      page,
      id,
      `function(){const e=this.nodeType===1?this:this.parentElement;let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return !!a&&a!==e&&!e.contains(a)&&(['INPUT','TEXTAREA'].includes(a.tagName)||a.isContentEditable);}`,
    ).catch(() => false);
    if (!moved) await page.cdp("DOM.focus", { backendNodeId: id }).catch(() => {});
    if (replace) {
      const a = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
      await page.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...a, commands: ["selectAll"] });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...a });
    } else {
      // At the end of the field's whole text: a multi-line field's End stops at the end of its line, so the caret is put
      // after the last character. A field that takes no selection (an email or number input) is one line, and End is its end.
      const placed = await page
        .evaluate(() => {
          let a = document.activeElement as (HTMLElement & { value?: unknown; setSelectionRange?: (start: number, end: number) => void }) | null;
          while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement as typeof a;
          if (!a) return false;
          if (typeof a.value === "string" && typeof a.setSelectionRange === "function") {
            try {
              a.setSelectionRange(a.value.length, a.value.length);
              return true;
            } catch {
              return false;
            }
          }
          if (!a.isContentEditable) return false;
          const range = document.createRange();
          range.selectNodeContents(a);
          range.collapse(false);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return true;
        })
        .catch(() => false);
      if (!placed) await this.key(page, "End", 35);
    }
    if (text === "") {
      if (replace) await this.key(page, "Backspace", 8);
    } else {
      // Datepickers and autocompletes react to key events, which insertText never sends: type the last character as a key.
      // Paced typing (`delayMs`) sends each character apart, that long after the one before.
      const chars = [...text];
      const last = chars.pop()!;
      if (delayMs > 0) {
        for (const char of chars) {
          await page.cdp("Input.insertText", { text: char });
          await delay(delayMs);
        }
      } else if (chars.length) await page.cdp("Input.insertText", { text: chars.join("") });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: last, text: last });
      await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: last });
    }
    const actual = await (moved
      ? page.evaluate(() => {
          let a = document.activeElement as HTMLInputElement | null;
          while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement as HTMLInputElement;
          return a ? (a.isContentEditable ? a.innerText : (a.value ?? "")) : "";
        })
      : this.onNode<string>(page, id, `function(){const e=this.nodeType===1?this:this.parentElement;return e.isContentEditable?e.innerText:(e.value??'');}`)
    ).catch(() => undefined);
    const expected = replace ? text : undefined;
    return ` = ${JSON.stringify(clip(text, 60))}${moved ? " (into the focused overlay input)" : ""}${actual !== undefined && (expected === undefined ? !actual.endsWith(text) : actual !== expected) ? ` (field now shows ${JSON.stringify(clip(actual, 60))})` : ""}`;
  }

  private async key(page: Page, key: string, keyCode: number, text?: string, modifiers = 0, code = key) {
    const k = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(modifiers ? { modifiers } : {}) };
    await page.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
    if (text) await page.cdp("Input.dispatchKeyEvent", { type: "char", ...k, text, unmodifiedText: text });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }
}
