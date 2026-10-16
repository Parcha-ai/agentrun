// The run page: job history, and for one run a timeline, its files and, live, chat and its browser. It reads only
// through a RunSource (source.js): the runs server's routes, or a replay from static files. It shows the ways to act
// (a new run, the message box, stop, the live browser) only when the source has them, and builds no absolute URL, so it
// works under any path. Run text is only ever put in the page as text nodes, or through md(), which escapes first.
import { failedCall, foldCalls, foldLabel, groupTimeline } from "./timeline/index.js";

const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yml", "yaml", "xml", "js", "mjs", "ts", "py", "sh", "toml", "ini", "css", "sql"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const LIVE_THINKING = /:live:thinking$/;
/** What a file view shows of a text file; the rest is the download's. */
const TEXT_CAP = 512 * 1024;
const RELEASED = new Set(["sleeping", "paused", "done", "failed"]);
export const REPLAY_NOTICE = "This is a replay: the run is recorded, nothing here acts on it, and its live browser is not part of it.";

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const enc = encodeURIComponent;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const usd = (n) => (n == null ? "" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const finished = (info) => ["done", "failed"].includes(info.status);

/** Markdown, escaped first: headings, lists, fences, code, bold, italic and http(s) links. */
export function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const ends = { ul: "</ul>", code: "</code></pre>", p: "</p>" };
  const out = [];
  let open = "";
  const close = () => {
    if (open) out.push(ends[open]);
    open = "";
  };
  const begin = (kind, tag) => {
    close();
    out.push(tag);
    open = kind;
  };
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      if (open === "code") close();
      else begin("code", "<pre><code>");
    } else if (open === "code") out.push(`${esc(line)}\n`);
    else if (/^#{1,6}\s/.test(line)) {
      const level = 3 + Math.min(2, line.match(/^#+/)[0].length - 1);
      close();
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      if (open !== "ul") begin("ul", "<ul>");
      out.push(`<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
    } else if (!line.trim()) close();
    else {
      if (open === "p") out.push("<br>");
      else begin("p", "<p>");
      out.push(inline(line));
    }
  }
  close();
  return out.join("");
}

export function csv(text, sep) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (quoted && c === '"') quoted = false;
    else if (quoted) cell += c;
    else if (c === '"') quoted = true;
    else if (c === sep) endCell();
    else if (c === "\n") {
      endCell();
      rows.push(row);
      row = [];
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    endCell();
    rows.push(row);
  }
  return rows;
}

/** The themes the page draws in: `auto` follows the system's light or dark. */
export const THEMES = ["auto", "light", "dark"];
/** What a sandboxed file frame's document is told its colors are, so it is not painted light on a dark page. */
const FRAME_SCHEME = { auto: "light dark", light: "light", dark: "dark" };

/** Agent HTML for a sandboxed frame, told the page's color scheme: the meta goes after a doctype, so the document keeps
 *  its mode. */
function themedFrame(html, theme) {
  const meta = `<meta name="color-scheme" content="${FRAME_SCHEME[theme]}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}

/**
 * Draw the run page into `root` and keep it current from `source`. Returns `unmount`, which stops every timer, stream
 * and listener the page holds. `theme` sets `data-theme` on `root`; every color is a `--ar-*` token there, which a host
 * may also set in its own CSS.
 * @param {HTMLElement} root
 * @param {import("./source.js").RunSource} source
 * @param {{ theme?: "auto" | "light" | "dark" }} [options]
 */
export function mountRunPage(root, source, { theme = "auto" } = {}) {
  if (!THEMES.includes(theme)) throw new Error(`the run page's theme is one of ${THEMES.join(", ")}, not ${JSON.stringify(theme)}`);
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const can = { start: typeof source.start === "function", submit: typeof source.submit === "function", stop: typeof source.stop === "function", live: typeof source.live === "function" };
  const replay = !can.start && !can.submit && !can.stop && !can.live;

  const el = (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    n.append(...kids.flat().filter((k) => k != null && k !== false && k !== ""));
    return n;
  };
  const pill = (cls, text) => el("span", { class: `pill ${cls}` }, el("i", { class: "dot" }), text);
  const btn = (attrs, text) => el("button", { type: "button", ...attrs }, text);

  // ---- the page's parts: only the ways to act this source has -----------------------------------------------------------
  const p = {
    q: el("input", { id: "q", type: "search", placeholder: replay ? "Search runs" : "Search runs and files", autocomplete: "off", "aria-label": "Search runs" }),
    new: can.start ? btn({ id: "new", class: "btn primary" }, "New run") : null,
    runs: el("ul", { id: "runs" }),
    view: el("section", { id: "view", class: "view" }),
    title: el("h1", { id: "title" }),
    pill: el("span", { id: "pill" }),
    cost: el("span", { id: "cost", class: "mono" }),
    stop: can.stop ? btn({ id: "stop", class: "btn", hidden: true }, "Stop") : null,
    notice: replay ? el("div", { id: "replay", class: "notice" }, REPLAY_NOTICE) : null,
    bannerText: el("span", { id: "banner-text" }),
    bannerBtn: can.live ? btn({ id: "banner-btn", class: "btn" }, "Open live browser") : null,
    steps: el("div", { id: "steps", class: "pane" }),
    files: el("div", { id: "files", class: "pane" }),
    browser: el("div", { id: "browser", class: "pane" }),
    err: el("div", { id: "err", class: "err" }),
    text: can.submit ? el("textarea", { id: "text", rows: 2 }) : null,
    send: can.submit ? btn({ id: "send", class: "btn primary" }, "Send") : null,
  };
  p.banner = el("div", { id: "banner", class: "banner", hidden: true }, el("b", {}, "Waiting for you"), p.bannerText, p.bannerBtn);
  const tab = (name, label) => btn({ "data-tab": name }, label);
  p.tabs = el("nav", { class: "tabs" }, tab("timeline", "Timeline"), tab("files", "Files"), can.live ? tab("browser", "Browser") : null);
  p.run = el(
    "section",
    { id: "run", class: "run", hidden: true },
    el("div", { class: "top-row" }, p.title, p.pill, p.cost, p.stop),
    p.notice,
    p.banner,
    p.tabs,
    p.steps,
    p.files,
    p.browser,
    p.err,
    p.text ? el("div", { class: "composer" }, p.text, p.send) : null,
  );
  p.bar = el("nav", { class: "bar" }, btn({ "data-pane": "hist" }, "Runs"), tab("timeline", "Timeline"), tab("files", "Files"), can.live ? tab("browser", "Browser") : null);
  root.setAttribute("class", `runs-app${replay ? " replay" : ""}`);
  root.replaceChildren(
    el("header", { class: "top" }, el("a", { class: "brand", href: "#/" }, "agentrun ", el("span", {}, replay ? "replay" : "runs")), p.q),
    el("main", {}, el("aside", { id: "hist", class: "hist", "aria-label": "Job history" }, el("div", { class: "head" }, el("b", {}, "Job history"), p.new), p.runs), p.view, p.run),
    p.bar,
  );
  root.dataset.pane = "run";
  root.dataset.tab = "timeline";
  root.setAttribute("data-theme", theme);

  const ui = { id: null, info: null, rows: [], state: "idle", cost: null, open: new Set(), follow: null, timer: null, sig: "", file: null, files: new Set(), filesSig: "", browserKey: "", shown: false, secs: new Map(), liveSince: new Map(), blobs: [] };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = win.setTimeout(() => (timers.delete(t), fn()), ms);
    timers.add(t);
    return t;
  };
  const fileHref = (path) => `#/run/${enc(ui.id)}/files/${path.split("/").map(enc).join("/")}`;
  /** An object URL for bytes the page shows or hands over, let go when the run or file changes. */
  const blobUrl = (blob) => {
    const url = win.URL.createObjectURL(blob);
    ui.blobs.push(url);
    return url;
  };
  const dropBlobs = () => {
    for (const url of ui.blobs.splice(0)) win.URL.revokeObjectURL(url);
  };

  // ---- timeline ----------------------------------------------------------------------------------------------------------
  const details = (key, cls, summary, ...body) => el("details", { class: cls, "data-k": key, open: ui.open.has(key) }, el("summary", {}, ...summary), ...body);

  function thinking(r) {
    const secs = ui.secs.get(r.id) ?? (ui.liveSince.has(r.id) ? Math.round((Date.now() - ui.liveSince.get(r.id)) / 1000) : null);
    return details(r.id, "row think", [`Thinking${secs == null ? "" : ` · ${secs}s`}`], el("pre", {}, r.text ?? r.summary));
  }

  const callState = (c) => (!c.result ? "running" : !failedCall(c) ? "ok" : c.result.tool_result_size_bytes === null ? "paused" : "error");

  function callLine(c) {
    if (c.use.tool_name === "request_sign_in") return details(c.use.id, "call signin", [pill(callState(c)), el("b", {}, "Sign-in"), el("span", { class: "s" }, c.use.summary)], c.result?.tool_result_preview ? el("pre", {}, c.result.tool_result_preview) : null);
    const inner = c.inner.length ? el("div", { class: "kids" }, c.inner.map(item)) : null;
    const failed = failedCall(c) && c.result.tool_result_size_bytes !== null ? el("pre", {}, c.result.summary) : null;
    return details(c.use.id, "call", [pill(callState(c)), el("b", {}, c.use.summary), el("span", { class: "s" }, c.use.tool_name)], c.use.tool_input_preview ? el("pre", {}, c.use.tool_input_preview) : null, c.result?.tool_result_preview ? el("pre", {}, c.result.tool_result_preview) : null, failed, inner);
  }

  function foldLine(fold) {
    const bad = fold.calls.filter(failedCall).length;
    const state = fold.calls.some((c) => !c.result) ? "running" : bad ? "error" : "ok";
    const label = foldLabel(fold.tool, fold.calls.map((c) => ({ input: c.use.tool_input_preview, output: c.result?.tool_result_preview ?? null })));
    return details(`${fold.calls[0].use.id}:fold`, "call", [pill(state), el("b", {}, label), el("span", { class: "s" }, bad ? `${fold.calls.length - bad} ok, ${bad} failed` : "")], el("div", { class: "kids" }, fold.calls.map(callLine)));
  }

  /** A saved file links to the Files tab when the run's file list has it (the model may have written an absolute path). */
  function savedLink(row) {
    const path = row.path;
    const known = path && [...ui.files].filter((f) => path === f || path.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0];
    return known ? el("div", { class: "row file" }, "Saved ", el("a", { href: fileHref(known) }, known)) : null;
  }

  function rowNode(r) {
    switch (r.kind) {
      case "user_message":
        return el("div", { class: "row user" }, r.text ?? r.summary);
      case "thinking":
        return thinking(r);
      case "text_block":
      case "final_answer":
        return Object.assign(el("div", { class: "row md" }), { innerHTML: md(r.text ?? r.summary ?? "") });
      case "waiting":
        return el("div", { class: "row phase w" }, r.summary);
      case "error":
        return el("div", { class: "row error" }, r.text ?? r.summary);
      case "usage":
        return null;
      default:
        return (r.kind === "phase" && savedLink(r)) || el("div", { class: "row phase" }, r.summary);
    }
  }

  function item(g) {
    return g.type === "row" ? rowNode(g.row) : el("div", { class: "round" }, foldCalls(g.calls).map((f) => (f.calls.length === 1 ? callLine(f.calls[0]) : foldLine(f))));
  }

  let queued = false;
  function paint() {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      const box = p.steps;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      box.replaceChildren(...groupTimeline(ui.rows.filter((r) => r.kind !== "usage")).map(item).filter(Boolean));
      if (stick) box.scrollTop = box.scrollHeight;
      paintHead();
    });
  }
  const ticking = win.setInterval(() => ui.rows.some((r) => LIVE_THINKING.test(r.id)) && paint(), 1000);

  /** A timeline view: its rows replace the page's. A live thinking row that went away timed the thinking it became. */
  function apply(view) {
    const next = new Set(view.rows.map((r) => r.id));
    let elapsed;
    for (const r of ui.rows) {
      if (next.has(r.id) || !ui.liveSince.has(r.id)) continue;
      elapsed = Math.round((Date.now() - ui.liveSince.get(r.id)) / 1000);
      ui.liveSince.delete(r.id);
    }
    const before = new Set(ui.rows.map((r) => r.id));
    for (const r of view.rows) {
      if (LIVE_THINKING.test(r.id)) {
        if (!ui.liveSince.has(r.id)) ui.liveSince.set(r.id, Date.now());
      } else if (r.kind === "thinking" && !before.has(r.id) && elapsed !== undefined && !ui.secs.has(r.id)) {
        ui.secs.set(r.id, elapsed);
        elapsed = undefined;
      }
    }
    ui.rows = [...view.rows];
    ui.state = view.state;
    ui.cost = view.costUsd;
    paint();
  }

  // ---- one run -----------------------------------------------------------------------------------------------------------
  function label(info, state) {
    if (finished(info) || ["lost", "starting"].includes(info.status)) return [info.status, cap(info.status)];
    if (state === "working") return ["working", "Running"];
    if (state === "waiting") return ["waiting", "Waiting for you"];
    if (info.live) return ["idle", "Idle"];
    return [info.status, cap(info.status)];
  }

  function paintHead() {
    const { info } = ui;
    if (!info) return;
    const [cls, text] = label(info, ui.state);
    p.title.textContent = info.title;
    p.pill.replaceChildren(pill(cls, text));
    // A replay's figure is its summary's alone: a recording that is not real has none, never its rows' $0.
    p.cost.textContent = usd(replay ? info.costUsd : (info.costUsd ?? ui.cost)) || info.id;
    if (p.stop) p.stop.hidden = !(info.live && ui.state === "working");
    const waiting = ui.state === "waiting" && !finished(info) && !replay;
    const view = can.live ? source.live(ui.id, info) : null;
    if (waiting && view && !ui.shown) {
      ui.shown = true;
      root.dataset.tab = "browser";
    }
    if (!waiting) ui.shown = false;
    p.banner.hidden = !waiting;
    p.bannerText.textContent = (ui.rows.findLast((r) => r.kind === "waiting")?.summary ?? "").replace(/^Waiting for you:?\s*/, "");
    if (p.bannerBtn) p.bannerBtn.hidden = !view;
    if (p.text) {
      // A finished run takes no more messages; the agent's next run starts from its home, signed in.
      const done = finished(info);
      p.text.disabled = done;
      p.send.disabled = done && !can.start;
      p.send.textContent = done && can.start ? "New run" : "Send";
      p.text.placeholder = done ? (info.outcome ? "This run is finished. A new run starts signed in." : `This run is ${info.status}.`) : ui.state === "working" ? "Steer the agent: it reads this at its next step" : "Message the agent";
    }
    p.err.textContent = info.error ?? "";
  }

  function closeRun() {
    ui.follow?.abort();
    ui.follow = null;
    win.clearTimeout(ui.timer);
    dropBlobs();
  }

  function openRun() {
    closeRun();
    Object.assign(ui, { info: null, rows: [], state: "idle", cost: null, sig: "", file: null, files: new Set(), filesSig: "", browserKey: "", shown: false, secs: new Map(), liveSince: new Map() });
    p.view.hidden = true;
    p.run.hidden = false;
    for (const node of [p.steps, p.files, p.browser, p.title, p.pill, p.cost, p.err]) node.replaceChildren();
    if (p.text) p.text.value = "";
    root.dataset.tab = "timeline";
    tick(ui.id);
  }

  /** Follow a live run's timeline until it ends, the page leaves the run, or the run stops serving. */
  async function follow(id) {
    const stop = new AbortController();
    ui.follow = stop;
    try {
      for await (const view of source.timeline(id, { live: true, signal: stop.signal })) {
        if (stop.signal.aborted || id !== ui.id) break;
        apply(view);
      }
    } catch {
      // A stream that broke is opened again by the next tick, while the run is live.
    } finally {
      if (ui.follow === stop) ui.follow = null;
    }
  }

  async function tick(id) {
    if (id !== ui.id) return;
    let info;
    try {
      info = await source.run(id);
    } catch (e) {
      if (id === ui.id) p.steps.replaceChildren(el("div", { class: "note" }, e.message));
      return;
    }
    if (id !== ui.id) return;
    ui.info = info;
    if (info.live && !replay) {
      if (!ui.follow) void follow(id);
    } else if (replay || RELEASED.has(info.status)) {
      ui.follow?.abort();
      ui.follow = null;
      const sig = [info.status, info.generation, info.endedAt].join();
      if (sig !== ui.sig) {
        ui.sig = sig;
        const t = await source.timeline(id, { live: false }).catch(() => null);
        // The page left this run, or was unmounted, while the timeline loaded: nothing more for it.
        if (id !== ui.id) return;
        if (t) apply(t);
      }
    } else if (!ui.rows.length) p.steps.replaceChildren(el("div", { class: "note" }, info.status === "starting" ? "Starting the run…" : `The run is ${info.status}.`));
    paintHead();
    paintBrowser();
    loadFiles();
    // A replay does not change: it is read once.
    if (!replay) ui.timer = later(() => tick(id), info.live ? 4000 : 2000);
  }

  async function send() {
    if (ui.info && finished(ui.info)) {
      if (can.start) win.location.hash = "#/";
      return;
    }
    const content = p.text.value.trim();
    if (!content || !ui.id) return;
    const id = ui.id;
    p.send.disabled = true;
    try {
      await source.submit(id, content);
      p.text.value = "";
      p.err.textContent = "";
      win.clearTimeout(ui.timer);
      tick(id);
    } catch (e) {
      p.err.textContent = e.message;
    }
    p.send.disabled = false;
  }

  // ---- browser and files -------------------------------------------------------------------------------------------------
  /** One frame per run, reloaded only when the live view's address changes (its key), never on a rewrite of live.json. */
  function paintBrowser() {
    if (!can.live) {
      if (ui.browserKey !== "none") p.browser.replaceChildren(el("div", { class: "note" }, replay ? "The live browser is not part of a replay." : "This page shows no live browser."));
      ui.browserKey = "none";
      return;
    }
    const view = ui.info ? source.live(ui.id, ui.info) : null;
    const note = ui.info?.liveNote;
    const local = ui.info?.browser === "chrome";
    const key = view ? `${ui.id}:${view.key}:${local}` : `none:${note ?? ""}`;
    if (key === ui.browserKey) return;
    ui.browserKey = key;
    const frame = view && el("iframe", { src: view.src, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups", referrerpolicy: "no-referrer", allow: "clipboard-read; clipboard-write" });
    // On a local Chrome, input that arrives while the agent's browser call runs is dropped, not queued: the viewer says so.
    const caption = local && el("div", { class: "note" }, "This is the agent's own Chrome. While the agent is using it, what you click or type is dropped, not queued, and the viewer says so: try again when it is done.");
    p.browser.replaceChildren(...(view ? [caption, frame].filter(Boolean) : [el("div", { class: "note" }, note ? `This run's browser: ${note}.` : "This run has no live browser right now.")]));
  }

  async function loadFiles() {
    const id = ui.id;
    const files = await source.files(id).catch(() => null);
    if (id !== ui.id || !files) return;
    ui.files = new Set(files.map((f) => f.path));
    const sig = JSON.stringify(files);
    if (ui.file || sig === ui.filesSig) return;
    ui.filesSig = sig;
    p.files.replaceChildren(files.length ? el("div", { class: "files" }, files.map((f) => el("a", { href: fileHref(f.path) }, el("span", {}, f.path), el("span", { class: "mono" }, f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`)))) : el("div", { class: "note" }, "No files yet. Whatever the agent writes in its work folder shows up here."));
    if (ui.rows.length) paint();
  }

  /** One file: text as text (markdown rendered escaped, CSV as a table), images inline, agent-written HTML in a frame
   *  with no scripts and its own origin (sandbox with nothing allowed), anything else as a download only. */
  async function viewFile(path) {
    const id = ui.id;
    const ext = path.split(".").pop().toLowerCase();
    const res = await source.file(id, path).catch(() => null);
    if (ui.file !== path || ui.id !== id) return;
    const bytes = res?.ok ? await res.blob() : null;
    if (ui.file !== path || ui.id !== id) return;
    const truncated = Boolean(bytes && res.headers.get("x-truncated"));
    const name = path.split("/").pop();
    const failed = el("p", { class: "err", hidden: true });
    const download = !bytes ? null : truncated ? wholeOnClick(id, path, name, failed) : el("a", { href: blobUrl(new Blob([bytes], { type: "application/octet-stream" })), download: name }, "Download");
    const bar = el("div", { class: "bar2" }, el("a", { href: `#/run/${enc(id)}` }, "Files"), el("b", {}, path), download);
    let body;
    if (!bytes) body = el("div", { class: "note" }, "This file is not available.");
    else if (ext === "html" || ext === "htm") body = Object.assign(el("iframe", { sandbox: "", referrerpolicy: "no-referrer", title: path }), { srcdoc: themedFrame(await bytes.text(), theme) });
    else if (IMAGES.has(ext)) body = el("img", { src: blobUrl(bytes), alt: path });
    else if (TEXT.has(ext)) {
      const all = await bytes.text();
      const text = all.length > TEXT_CAP ? all.slice(0, TEXT_CAP) : all;
      if (ext === "md" || ext === "markdown") body = Object.assign(el("div", { class: "md" }), { innerHTML: md(text) });
      else if (ext === "csv" || ext === "tsv") {
        const [head, ...rows] = csv(text, ext === "csv" ? "," : "\t");
        body = el("table", {}, el("thead", {}, el("tr", {}, (head ?? []).map((c) => el("th", {}, c)))), el("tbody", {}, rows.slice(0, 500).map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))));
      } else body = el("pre", {}, text);
      if (text !== all || truncated) body = el("div", {}, body, el("p", { class: "note" }, "The file is longer than the preview. Download it to read the rest."));
    } else body = el("div", { class: "note" }, "No preview for this type. Use Download.");
    if (ui.file === path && ui.id === id) p.files.replaceChildren(el("div", { class: "viewer" }, bar, failed, body));
  }

  /** Download for a file the preview shows cut short: the whole file is fetched only when it is clicked, then saved;
   *  a failure is said in `failed` and the preview stays. */
  function wholeOnClick(id, path, name, failed) {
    const link = el("a", { href: "#", class: "download" }, "Download");
    let state = "idle";
    // On the link itself, not the page's listeners: the handler goes with the node when the file view is replaced.
    link.addEventListener("click", async (event) => {
      if (state === "ready") return;
      event.preventDefault();
      if (state === "loading") return;
      state = "loading";
      failed.hidden = true;
      try {
        const res = await source.file(id, path, { download: true });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const whole = await res.blob();
        if (ui.file !== path || ui.id !== id) return;
        link.setAttribute("href", blobUrl(new Blob([whole], { type: "application/octet-stream" })));
        link.setAttribute("download", name);
        state = "ready";
        link.click();
      } catch (e) {
        state = "idle";
        failed.textContent = `The download failed: ${e.message}`;
        failed.hidden = false;
      }
    });
    return link;
  }

  // ---- history, new run, search, routes ----------------------------------------------------------------------------------
  async function loadRuns() {
    const runs = await source.list().catch(() => null);
    if (!runs) return;
    p.runs.replaceChildren(...runs.map((r) => {
      const [cls, text] = label(r, r.busy === "busy" ? "working" : (r.state ?? "idle"));
      return el("li", {}, el("a", { href: `#/run/${enc(r.id)}`, class: r.id === ui.id ? "on" : "" }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, pill(cls, text), el("span", {}, ago(r.startedAt)), r.costUsd != null ? el("span", {}, usd(r.costUsd)) : null), el("div", { class: "meta" }, [r.agent, r.id].filter(Boolean).join(" · "))));
    }));
  }

  function leaveRun() {
    closeRun();
    ui.id = null;
    ui.info = null;
    p.run.hidden = true;
    p.view.hidden = false;
    for (const node of [p.steps, p.files, p.browser]) node.replaceChildren();
  }

  function showHome() {
    leaveRun();
    if (!can.start) {
      p.view.replaceChildren(el("div", { class: "top-row" }, el("h1", {}, replay ? "Replay" : "Runs")), el("div", { class: "note" }, replay ? `${REPLAY_NOTICE} Pick a run from the history.` : "Pick a run from the history."));
      return;
    }
    const text = el("textarea", { rows: 4, placeholder: "What should the agent do?" });
    const err = el("div", { class: "err" });
    const go = btn({ class: "btn primary" }, "Start run");
    go.addEventListener("click", async () => {
      if (!text.value.trim()) return;
      go.disabled = true;
      try {
        win.location.hash = `#/run/${enc((await source.start(text.value)).id)}`;
      } catch (e) {
        err.textContent = e.message;
        go.disabled = false;
      }
    });
    p.view.replaceChildren(el("div", { class: "top-row" }, el("h1", {}, "New run")), el("div", { class: "note" }, "Tell the agent what to do. It starts in its own folder and you watch it here."), el("div", { class: "composer" }, text, go), err);
  }

  let searches = 0;
  async function showSearch(q) {
    const asked = ++searches;
    leaveRun();
    p.q.value = q;
    const hits = el("div", { class: "hits" }, el("div", { class: "note" }, "Searching…"));
    p.view.replaceChildren(el("div", { class: "top-row" }, el("h1", {}, `Search: ${q}`)), hits);
    const results = await source.search(q).catch(() => []);
    // Only the newest search draws: an older answer that arrives late, or one for a page left since, is dropped.
    if (asked !== searches) return;
    const link = (r) => (r.kind === "file" ? `#/run/${enc(r.runId)}/files/${r.path.split("/").map(enc).join("/")}` : `#/run/${enc(r.runId)}`);
    hits.replaceChildren(...(results.length ? results.map((r) => el("a", { href: link(r) }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, `${r.kind}${r.path ? ` · ${r.path}` : ""}`), el("div", {}, r.snippet))) : [el("div", { class: "note" }, "Nothing found.")]));
  }

  function show(pane, tabName) {
    root.dataset.pane = pane;
    if (tabName) root.dataset.tab = tabName;
  }

  function route() {
    const [, kind, id, sub, ...path] = win.location.hash.split("/").map((part) => decodeURIComponent(part));
    if (kind !== "search") searches++;
    if (kind === "run" && id) {
      const file = sub === "files" && path.length ? path.join("/") : null;
      if (id !== ui.id) {
        ui.id = id;
        openRun();
      }
      if (file) ui.shown = true;
      if (file !== ui.file) {
        ui.file = file;
        ui.filesSig = "";
        dropBlobs();
        if (file) viewFile(file);
        else loadFiles();
      }
      show("run", file ? "files" : undefined);
    } else if (kind === "search" && id) {
      showSearch(id);
      show("run");
    } else {
      showHome();
      show("run");
    }
    loadRuns();
  }

  let searching;
  const listeners = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };
  if (p.new) on(p.new, "click", () => (win.location.hash = "#/"));
  on(p.q, "input", (e) => {
    win.clearTimeout(searching);
    const q = e.target.value.trim();
    searching = later(() => (win.location.hash = q.length > 1 ? `#/search/${enc(q)}` : "#/"), 300);
  });
  if (p.send) {
    on(p.send, "click", send);
    on(p.text, "keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      send();
    });
  }
  if (p.stop) on(p.stop, "click", () => source.stop(ui.id).catch((e) => (p.err.textContent = e.message)));
  if (p.bannerBtn) on(p.bannerBtn, "click", () => show("run", "browser"));
  on(
    p.steps,
    "toggle",
    (e) => {
      const key = e.target.dataset?.k;
      if (!key) return;
      if (e.target.open) ui.open.add(key);
      else ui.open.delete(key);
    },
    true,
  );
  for (const b of p.bar.children) on(b, "click", () => show(b.dataset.pane ?? "run", b.dataset.tab));
  for (const b of p.tabs.children) on(b, "click", () => (root.dataset.tab = b.dataset.tab));
  on(win, "hashchange", route);
  // A live history changes; a replay's does not.
  const polling = replay ? null : win.setInterval(loadRuns, 3000);
  route();

  return {
    unmount() {
      leaveRun();
      for (const off of listeners.splice(0)) off();
      for (const t of timers) win.clearTimeout(t);
      timers.clear();
      win.clearInterval(ticking);
      if (polling) win.clearInterval(polling);
    },
  };
}
