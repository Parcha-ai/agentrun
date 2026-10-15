// The runs page: job history, and for one run a timeline with chat, its files and its live browser. Timeline rows come
// from the server (Grep's TimelineEvent shape); this file groups them with the timeline module and draws them. Run text
// is only ever put in the page as text nodes, or through md(), which escapes first.
import { failedCall, foldCalls, foldLabel, groupTimeline } from "/timeline/index.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false && k !== ""));
  return n;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const enc = encodeURIComponent;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const usd = (n) => (n == null ? "" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yml", "yaml", "xml", "js", "mjs", "ts", "py", "sh", "toml", "ini", "css", "sql"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const LIVE_THINKING = /:live:thinking$/;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? res.statusText);
  return data;
}

/** Markdown, escaped first: headings, lists, fences, code, bold, italic and http(s) links. */
function md(text) {
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

function csv(text, sep) {
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

const ui = { id: null, info: null, rows: [], state: "idle", cost: null, open: new Set(), es: null, timer: null, sig: "", file: null, files: new Set(), filesSig: "", browserKey: "", shown: false, canStart: false, secs: new Map(), liveSince: new Map() };
const pill = (cls, text) => el("span", { class: `pill ${cls}` }, el("i", { class: "dot" }), text);
const fileHref = (path) => `#/run/${enc(ui.id)}/files/${path.split("/").map(enc).join("/")}`;
const fileUrl = (path) => `/runs/${enc(ui.id)}/files/${path.split("/").map(enc).join("/")}`;
const finished = (info) => ["done", "failed"].includes(info.status);

// ---- timeline ----------------------------------------------------------------------------------------------------------
const details = (key, cls, summary, ...body) => el("details", { class: cls, "data-k": key, open: ui.open.has(key) }, el("summary", {}, ...summary), ...body);

function thinking(r) {
  const secs = ui.secs.get(r.id) ?? (ui.liveSince.has(r.id) ? Math.round((Date.now() - ui.liveSince.get(r.id)) / 1000) : null);
  return details(r.id, "row think", [`Thinking${secs == null ? "" : ` · ${secs}s`}`], el("pre", {}, r.text ?? r.summary));
}

const callState = (c) => (!c.result ? "running" : !failedCall(c) ? "ok" : c.result.tool_result_size_bytes === null ? "paused" : "error");

function callLine(c) {
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
function savedLink(summary) {
  const path = /^Saved (.+)$/.exec(summary)?.[1];
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
      return (r.kind === "phase" && savedLink(r.summary ?? "")) || el("div", { class: "row phase" }, r.summary);
  }
}

function item(g) {
  return g.type === "row" ? rowNode(g.row) : el("div", { class: "round" }, foldCalls(g.calls).map((f) => (f.calls.length === 1 ? callLine(f.calls[0]) : foldLine(f))));
}

let queued = false;
function paint() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const box = $("#steps");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...groupTimeline(ui.rows.filter((r) => r.kind !== "usage")).map(item).filter(Boolean));
    if (stick) box.scrollTop = box.scrollHeight;
    paintHead();
  });
}
setInterval(() => ui.rows.some((r) => LIVE_THINKING.test(r.id)) && paint(), 1000);

/** A `rows` message: every row (reset), or the rows to upsert and the ids to drop. Order is by seq. */
function apply(m) {
  let elapsed;
  for (const id of m.drop ?? []) {
    if (!ui.liveSince.has(id)) continue;
    elapsed = Math.round((Date.now() - ui.liveSince.get(id)) / 1000);
    ui.liveSince.delete(id);
  }
  for (const r of m.set ?? m.rows) {
    if (LIVE_THINKING.test(r.id)) {
      if (!ui.liveSince.has(r.id)) ui.liveSince.set(r.id, Date.now());
    } else if (r.kind === "thinking" && elapsed !== undefined && !ui.secs.has(r.id)) {
      ui.secs.set(r.id, elapsed);
      elapsed = undefined;
    }
  }
  if (m.reset) ui.rows = [...m.rows];
  else {
    const gone = new Set(m.drop);
    const byId = new Map(ui.rows.filter((r) => !gone.has(r.id)).map((r) => [r.id, r]));
    for (const r of m.set) byId.set(r.id, r);
    ui.rows = [...byId.values()];
  }
  ui.rows.sort((a, b) => a.seq - b.seq);
  ui.state = m.state;
  ui.cost = m.costUsd;
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
  $("#title").textContent = info.title;
  $("#pill").replaceChildren(pill(cls, text));
  $("#cost").textContent = usd(info.costUsd ?? ui.cost) || info.id;
  $("#stop").hidden = !(info.live && ui.state === "working");
  const waiting = ui.state === "waiting" && !finished(info);
  if (waiting && info.liveView && !ui.shown) {
    ui.shown = true;
    document.body.dataset.tab = "browser";
  }
  if (!waiting) ui.shown = false;
  $("#banner").hidden = !waiting;
  $("#banner-text").textContent = (ui.rows.findLast((r) => r.kind === "waiting")?.summary ?? "").replace(/^Waiting for you:?\s*/, "");
  $("#banner-btn").hidden = !info.liveView;
  $("#text").disabled = $("#send").disabled = finished(info);
  $("#text").placeholder = finished(info) ? `This run is ${info.status}` : ui.state === "working" ? "Steer the agent: it reads this at its next step" : "Message the agent";
  $("#err").textContent = info.error ?? "";
}

function openRun() {
  Object.assign(ui, { info: null, rows: [], state: "idle", cost: null, sig: "", file: null, files: new Set(), filesSig: "", browserKey: "", shown: false, secs: new Map(), liveSince: new Map() });
  ui.es?.close();
  ui.es = null;
  clearTimeout(ui.timer);
  $("#view").hidden = true;
  $("#run").hidden = false;
  for (const id of ["#steps", "#files", "#browser", "#title", "#pill", "#cost", "#err"]) $(id).replaceChildren();
  $("#text").value = "";
  document.body.dataset.tab = "timeline";
  tick(ui.id);
}

async function tick(id) {
  if (id !== ui.id) return;
  let info;
  try {
    info = await api(`/runs/${enc(id)}`);
  } catch (e) {
    $("#steps").replaceChildren(el("div", { class: "note" }, e.message));
    return;
  }
  if (id !== ui.id) return;
  ui.info = info;
  if (info.live) {
    if (!ui.es) {
      const es = (ui.es = new EventSource(`/runs/${enc(id)}/timeline`));
      const drop = () => {
        es.close();
        if (ui.es === es) ui.es = null;
      };
      es.addEventListener("rows", (e) => apply(JSON.parse(e.data)));
      es.addEventListener("end", drop);
      es.onerror = drop;
    }
  } else if (["sleeping", "paused", "done", "failed"].includes(info.status)) {
    ui.es?.close();
    ui.es = null;
    const sig = [info.status, info.generation, info.endedAt].join();
    if (sig !== ui.sig) {
      ui.sig = sig;
      const t = await api(`/runs/${enc(id)}/timeline`).catch(() => null);
      if (t && id === ui.id) apply({ reset: true, rows: t.rows, state: t.state, costUsd: t.costUsd });
    }
  } else if (!ui.rows.length) $("#steps").replaceChildren(el("div", { class: "note" }, info.status === "starting" ? "Starting the run…" : `The run is ${info.status}.`));
  paintHead();
  paintBrowser();
  loadFiles();
  ui.timer = setTimeout(() => tick(id), info.live ? 4000 : 2000);
}

async function send() {
  const content = $("#text").value.trim();
  if (!content || !ui.id) return;
  const id = ui.id;
  $("#send").disabled = true;
  try {
    await api(`/runs/${enc(id)}/messages`, { content });
    $("#text").value = "";
    $("#err").textContent = "";
    clearTimeout(ui.timer);
    tick(id);
  } catch (e) {
    $("#err").textContent = e.message;
  }
  $("#send").disabled = false;
}

// ---- browser and files -------------------------------------------------------------------------------------------------
/** One frame per run, reloaded only when the live view's address changes (its key), never on a rewrite of live.json. */
function paintBrowser() {
  const view = ui.info?.liveView;
  const key = view ? `${ui.id}:${view.key}` : "none";
  if (key === ui.browserKey) return;
  ui.browserKey = key;
  $("#browser").replaceChildren(view ? el("iframe", { src: `/runs/${enc(ui.id)}/live?v=${view.key}`, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups", referrerpolicy: "no-referrer", allow: "clipboard-read; clipboard-write" }) : el("div", { class: "note" }, "This run has no live browser right now."));
}

async function loadFiles() {
  const id = ui.id;
  const { files } = await api(`/runs/${enc(id)}/files`).catch(() => ({ files: null }));
  if (id !== ui.id || !files) return;
  ui.files = new Set(files.map((f) => f.path));
  const sig = JSON.stringify(files);
  if (ui.file || sig === ui.filesSig) return;
  ui.filesSig = sig;
  $("#files").replaceChildren(files.length ? el("div", { class: "files" }, files.map((f) => el("a", { href: fileHref(f.path) }, el("span", {}, f.path), el("span", { class: "mono" }, f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`)))) : el("div", { class: "note" }, "No files yet. Whatever the agent writes in its work folder shows up here."));
  if (ui.rows.length) paint();
}

async function viewFile(path) {
  const id = ui.id;
  const url = fileUrl(path);
  const ext = path.split(".").pop().toLowerCase();
  const bar = el("div", { class: "bar2" }, el("a", { href: `#/run/${enc(id)}` }, "Files"), el("b", {}, path), el("a", { href: `${url}?download=1` }, "Download"));
  let body;
  if (ext === "html" || ext === "htm") body = el("iframe", { src: url, sandbox: "" });
  else if (IMAGES.has(ext)) body = el("img", { src: url, alt: path });
  else if (TEXT.has(ext)) {
    const res = await fetch(url);
    const text = res.ok ? await res.text() : "";
    if (ui.file !== path || ui.id !== id) return;
    if (!res.ok) body = el("div", { class: "note" }, "This file is not available.");
    else if (ext === "md" || ext === "markdown") body = Object.assign(el("div", { class: "md" }), { innerHTML: md(text) });
    else if (ext === "csv" || ext === "tsv") {
      const [head, ...rows] = csv(text, ext === "csv" ? "," : "\t");
      body = el("table", {}, el("thead", {}, el("tr", {}, (head ?? []).map((c) => el("th", {}, c)))), el("tbody", {}, rows.slice(0, 500).map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))));
    } else body = el("pre", {}, text);
    if (res.headers.get("x-truncated")) body = el("div", {}, body, el("p", { class: "note" }, "The file is longer than the preview. Download it to read the rest."));
  } else body = el("div", { class: "note" }, "No preview for this type. Use Download.");
  if (ui.file === path && ui.id === id) $("#files").replaceChildren(el("div", { class: "viewer" }, bar, body));
}

// ---- history, new run, search, routes ----------------------------------------------------------------------------------
async function loadRuns() {
  const { runs, canStart } = await api("/runs").catch(() => ({ runs: null }));
  if (!runs) return;
  ui.canStart = canStart;
  $("#runs").replaceChildren(...runs.map((r) => {
    const [cls, text] = label(r, r.busy === "busy" ? "working" : (r.state ?? "idle"));
    return el("li", {}, el("a", { href: `#/run/${enc(r.id)}`, class: r.id === ui.id ? "on" : "" }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, pill(cls, text), el("span", {}, ago(r.startedAt)), r.costUsd != null ? el("span", {}, usd(r.costUsd)) : null), el("div", { class: "meta" }, [r.agent, r.id].filter(Boolean).join(" · "))));
  }));
}

function leaveRun() {
  ui.id = null;
  ui.info = null;
  ui.es?.close();
  ui.es = null;
  clearTimeout(ui.timer);
  $("#run").hidden = true;
  $("#view").hidden = false;
  for (const id of ["#steps", "#files", "#browser"]) $(id).replaceChildren();
}

function showNew() {
  leaveRun();
  const text = el("textarea", { rows: 4, placeholder: "What should the agent do?" });
  const err = el("div", { class: "err" });
  const start = async () => {
    if (!text.value.trim()) return;
    go.disabled = true;
    try {
      location.hash = `#/run/${enc((await api("/runs", { content: text.value })).id)}`;
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
    }
  };
  const go = el("button", { class: "btn primary", onclick: start }, "Start run");
  $("#view").replaceChildren(el("div", { class: "top-row" }, el("h1", {}, "New run")), el("div", { class: "note" }, ui.canStart ? "Tell the agent what to do. It starts in its own folder and you watch it here." : "This server has no start command, so it cannot start runs. Pick a run from the history."), el("div", { class: "composer" }, text, go), err);
}

async function showSearch(q) {
  leaveRun();
  $("#q").value = q;
  $("#view").replaceChildren(el("div", { class: "top-row" }, el("h1", {}, `Search: ${q}`)), el("div", { class: "hits" }, el("div", { class: "note" }, "Searching…")));
  const { results } = await api(`/search?q=${enc(q)}`).catch(() => ({ results: [] }));
  const link = (r) => (r.kind === "file" ? `#/run/${enc(r.runId)}/files/${r.path.split("/").map(enc).join("/")}` : `#/run/${enc(r.runId)}`);
  $("#view .hits").replaceChildren(...(results.length ? results.map((r) => el("a", { href: link(r) }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, `${r.kind}${r.path ? ` · ${r.path}` : ""}`), el("div", {}, r.snippet))) : [el("div", { class: "note" }, "Nothing found.")]));
}

function show(pane, tab) {
  document.body.dataset.pane = pane;
  if (tab) document.body.dataset.tab = tab;
}

function route() {
  const [, kind, id, sub, ...path] = location.hash.split("/").map((p) => decodeURIComponent(p));
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
      if (file) viewFile(file);
      else loadFiles();
    }
    show("run", file ? "files" : undefined);
  } else if (kind === "search" && id) {
    showSearch(id);
    show("run");
  } else {
    showNew();
    show("run");
  }
  loadRuns();
}

let searching;
$("#new").addEventListener("click", () => (location.hash = "#/"));
$("#q").addEventListener("input", (e) => {
  clearTimeout(searching);
  const q = e.target.value.trim();
  searching = setTimeout(() => (location.hash = q.length > 1 ? `#/search/${enc(q)}` : "#/"), 300);
});
$("#send").addEventListener("click", send);
$("#text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  send();
});
$("#stop").addEventListener("click", () => api(`/runs/${enc(ui.id)}/stop`, {}).catch((e) => ($("#err").textContent = e.message)));
$("#banner-btn").addEventListener("click", () => show("run", "browser"));
$("#steps").addEventListener(
  "toggle",
  (e) => {
    const key = e.target.dataset?.k;
    if (!key) return;
    if (e.target.open) ui.open.add(key);
    else ui.open.delete(key);
  },
  true,
);
for (const b of document.querySelectorAll(".bar button")) b.addEventListener("click", () => show(b.dataset.pane ?? "run", b.dataset.tab));
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => (document.body.dataset.tab = b.dataset.tab));
addEventListener("hashchange", route);
await loadRuns();
route();
setInterval(loadRuns, 3000);
