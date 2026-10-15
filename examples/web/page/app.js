// The runs page: job history, one run's live steps with chat, and a side panel with the live browser and the run's files.
// Rows come from the server already projected (rows.mjs); this file groups and draws them. Run text is only ever put in
// the page as text nodes, or through md(), which escapes first.
import { group } from "/rows.mjs";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false));
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

async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    if (quoted && c === '"' && text[i + 1] === '"') (cell += '"'), i++;
    else if (quoted && c === '"') quoted = false;
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

const ui = { id: null, info: null, rows: [], state: "idle", cost: 0, open: new Set(), es: null, timer: null, sig: "", file: null, filesSig: "", browserKey: "", shown: false, canStart: false, nodes: {} };
const pill = (cls, text) => el("span", { class: `pill ${cls}` }, el("i", { class: "dot" }), text);
const fileHref = (path) => `#/run/${enc(ui.id)}/files/${path.split("/").map(enc).join("/")}`;

// ---- steps -------------------------------------------------------------------------------------------------------------
const details = (key, cls, summary, ...body) => el("details", { class: cls, "data-k": key, open: ui.open.has(key) }, el("summary", {}, ...summary), ...body);

function think(r) {
  const secs = r.seconds ?? (r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : null);
  return details(r.id, "row think", [`Thinking${secs == null ? "" : ` · ${secs}s`}${r.redacted ? " (hidden)" : ""}`], el("pre", {}, r.text));
}

function call(c) {
  const kids = c.children?.length ? el("div", { class: "kids" }, c.children.map(call)) : null;
  const out = c.result ? c.result.tool_result_preview : c.output;
  return details(c.id, "call", [pill(c.status === "interrupted" ? "paused" : c.status), el("b", {}, c.summary), el("span", { class: "s" }, `${c.tool_name} ${c.tool_input_preview}`)], el("pre", {}, JSON.stringify(c.args, null, 2)), out ? el("pre", {}, out) : null, kids);
}

function item(r) {
  if (r.kind === "user_message") return el("div", { class: "row user" }, r.text);
  if (r.kind === "text_block") return Object.assign(el("div", { class: "row md" }), { innerHTML: md(r.text) });
  if (r.kind === "thinking") return think(r);
  if (r.kind === "phase" && r.path) return el("div", { class: "row file" }, "Saved ", el("a", { href: fileHref(r.path) }, r.path));
  if (r.kind === "phase") return el("div", { class: "row phase" }, r.summary);
  if (r.kind === "waiting") return el("div", { class: "row phase w" }, r.summary);
  if (r.kind === "error") return el("div", { class: "row error" }, r.text);
  const calls = r.items.filter((x) => x.kind === "tool_use");
  const state = calls.some((c) => c.status === "running") ? "running" : calls.some((c) => c.status === "error") ? "error" : "ok";
  return details(r.id, "group", [pill(state), el("span", { class: "fam" }, r.family), el("span", { class: "mono" }, `· ${calls.length} ${calls.length === 1 ? "action" : "actions"}`)], el("div", { class: "body" }, r.items.map((x) => (x.kind === "tool_use" ? call(x) : think(x)))));
}

let queued = false;
function paint() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const box = ui.nodes.steps;
    if (!box) return;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...group(ui.rows, { settled: ui.info ? !ui.info.live : false }).map(item));
    if (stick) box.scrollTop = box.scrollHeight;
    paintHead();
  });
}
setInterval(() => ui.rows.some((r) => r.partial && r.kind === "thinking") && paint(), 1000);

function apply(m) {
  if (m.reset) ui.rows = m.rows;
  else {
    const gone = new Set(m.drop);
    ui.rows = ui.rows.filter((r) => !gone.has(r.id));
    for (const r of m.set) {
      const i = ui.rows.findIndex((x) => x.id === r.id);
      if (i < 0) ui.rows.push(r);
      else ui.rows[i] = r;
    }
  }
  ui.state = m.state;
  ui.cost = m.costUsd;
  paint();
}

// ---- one run -----------------------------------------------------------------------------------------------------------
const finished = (info) => ["done", "failed"].includes(info.status);

function label(info, state) {
  if (finished(info)) return [info.status, cap(info.status)];
  if (["lost", "starting"].includes(info.status)) return [info.status, cap(info.status)];
  if (state === "working") return ["working", "Running"];
  if (state === "waiting" || (info.status === "sleeping" && !info.wakeAt)) return ["waiting", "Waiting for you"];
  return [info.status, cap(info.status)];
}

function paintHead() {
  const { info, nodes } = ui;
  if (!info || !nodes.title) return;
  const [cls, text] = label(info, ui.state);
  nodes.title.textContent = info.title;
  nodes.pill.replaceChildren(pill(cls, text));
  nodes.cost.textContent = usd(info.costUsd ?? (ui.cost || null)) || info.id;
  nodes.stop.hidden = !(info.live && ui.state === "working");
  const waiting = ui.state === "waiting" && !finished(info);
  if (waiting && info.liveView && !ui.shown) {
    ui.shown = true;
    document.body.dataset.tab = "browser";
  }
  if (!waiting) ui.shown = false;
  const last = ui.rows.findLast((r) => r.kind === "text_block");
  nodes.banner.hidden = !waiting;
  nodes.bannerText.textContent = last ? last.text.replace(/[*`#]/g, "").replace(/\s+/g, " ").slice(0, 200) : "";
  nodes.bannerBtn.hidden = !info.liveView;
  nodes.text.disabled = nodes.send.disabled = finished(info);
  nodes.text.placeholder = finished(info) ? `This run is ${info.status}` : ui.state === "working" ? "Steer the agent: it reads this at its next step" : "Message the agent";
  nodes.err.textContent = info.error ?? "";
}

function openRun() {
  const id = ui.id;
  Object.assign(ui, { info: null, rows: [], state: "idle", cost: 0, sig: "", file: null, filesSig: "", browserKey: "", shown: false });
  ui.es?.close();
  ui.es = null;
  const n = (ui.nodes = {});
  const send = async () => {
    const content = n.text.value.trim();
    if (!content) return;
    n.send.disabled = true;
    try {
      await api(`/runs/${enc(id)}/submit`, { content });
      n.text.value = "";
      n.err.textContent = "";
      clearTimeout(ui.timer);
      tick(id);
    } catch (e) {
      n.err.textContent = e.message;
    }
    n.send.disabled = false;
  };
  n.title = el("h1", {}, "…");
  n.pill = el("span");
  n.cost = el("span", { class: "mono" });
  n.stop = el("button", { class: "btn", hidden: true, onclick: () => api(`/runs/${enc(id)}/stop`, {}).catch((e) => (n.err.textContent = e.message)) }, "Stop");
  n.bannerText = el("span");
  n.bannerBtn = el("button", { class: "btn", onclick: () => showPane("browser") }, "Open live browser");
  n.banner = el("div", { class: "banner", hidden: true }, el("b", {}, "Waiting for you"), n.bannerText, n.bannerBtn);
  n.steps = el("div", { id: "steps" });
  n.steps.addEventListener(
    "toggle",
    (e) => {
      const key = e.target.dataset?.k;
      if (!key) return;
      if (e.target.open) ui.open.add(key);
      else ui.open.delete(key);
    },
    true,
  );
  n.err = el("div", { class: "err" });
  n.text = el("textarea", {
    rows: 2,
    onkeydown: (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      send();
    },
  });
  n.send = el("button", { class: "btn primary", onclick: send }, "Send");
  $("#run").replaceChildren(el("div", { class: "top-row" }, n.title, n.pill, n.cost, n.stop), n.banner, n.steps, n.err, el("div", { class: "composer" }, n.text, n.send));
  $("#files").replaceChildren();
  tick(id);
}

async function tick(id) {
  if (id !== ui.id) return;
  let info;
  try {
    info = await api(`/runs/${enc(id)}`);
  } catch (e) {
    ui.nodes.steps.replaceChildren(el("div", { class: "note" }, e.message));
    return;
  }
  if (id !== ui.id) return;
  ui.info = info;
  if (info.live) {
    if (!ui.es) {
      const es = (ui.es = new EventSource(`/api/runs/${enc(id)}/steps`));
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
  } else if (!ui.rows.length) ui.nodes.steps.replaceChildren(el("div", { class: "note" }, info.status === "starting" ? "Starting the run…" : `The run is ${info.status}.`));
  paintHead();
  paintBrowser();
  if (!ui.file) loadFiles();
  ui.timer = setTimeout(() => tick(id), info.live ? 4000 : 2000);
}

// ---- side panel --------------------------------------------------------------------------------------------------------
function paintBrowser() {
  const view = ui.info?.liveView;
  const key = view ? `${ui.id}:${view.updatedAt}` : "none";
  if (key === ui.browserKey) return;
  ui.browserKey = key;
  $("#browser").replaceChildren(view ? el("iframe", { src: `/api/runs/${enc(ui.id)}/live?v=${enc(view.updatedAt ?? "")}`, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups", referrerpolicy: "no-referrer", allow: "clipboard-read; clipboard-write" }) : el("div", { class: "note" }, "This run has no live browser right now."));
}

async function loadFiles() {
  const id = ui.id;
  const { files } = await api(`/runs/${enc(id)}/files`).catch(() => ({ files: null }));
  const sig = JSON.stringify(files);
  if (id !== ui.id || ui.file || !files || sig === ui.filesSig) return;
  ui.filesSig = sig;
  $("#files").replaceChildren(files.length ? el("div", { class: "files" }, files.map((f) => el("a", { href: fileHref(f.path) }, el("span", {}, f.path), el("span", { class: "mono" }, f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`)))) : el("div", { class: "note" }, "No files yet. Whatever the agent writes in its work folder shows up here."));
}

async function viewFile(path) {
  const id = ui.id;
  const url = `/api/runs/${enc(id)}/file?path=${enc(path)}`;
  const ext = path.split(".").pop().toLowerCase();
  const bar = el("div", { class: "bar2" }, el("a", { href: `#/run/${enc(id)}` }, "Files"), el("b", {}, path), el("a", { href: `${url}&download=1` }, "Download"));
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

// ---- history, new run, search, routes ---------------------------------------------------------------------------------
async function loadRuns() {
  const { runs, canStart } = await api("/runs").catch(() => ({ runs: null }));
  if (!runs) return;
  ui.canStart = canStart;
  $("#runs").replaceChildren(...runs.map((r) => {
    const [cls, text] = label(r, { busy: "working", idle: "waiting" }[r.busy] ?? "idle");
    return el("li", {}, el("a", { href: `#/run/${enc(r.id)}`, class: r.id === ui.id ? "on" : "" }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, pill(cls, text), el("span", {}, ago(r.startedAt)), r.costUsd != null ? el("span", {}, usd(r.costUsd)) : null)));
  }));
}

function leaveRun() {
  ui.id = null;
  ui.info = null;
  ui.nodes = {};
  ui.es?.close();
  ui.es = null;
  clearTimeout(ui.timer);
  $("#browser").replaceChildren();
  $("#files").replaceChildren();
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
  $("#run").replaceChildren(el("div", { class: "top-row" }, el("h1", {}, "New run")), el("div", { class: "note" }, ui.canStart ? "Tell the agent what to do. It starts in its own folder and you watch it here." : "This server was started without --start, so it cannot start runs. Pick a run from the history."), el("div", { class: "composer" }, text, go), err);
}

async function showSearch(q) {
  leaveRun();
  $("#q").value = q;
  $("#run").replaceChildren(el("div", { class: "top-row" }, el("h1", {}, `Search: ${q}`)), el("div", { class: "hits" }, el("div", { class: "note" }, "Searching…")));
  const { results } = await api(`/search?q=${enc(q)}`).catch((e) => ({ results: [], error: e }));
  const link = (r) => (r.kind === "file" ? `#/run/${enc(r.runId)}/files/${r.path.split("/").map(enc).join("/")}` : `#/run/${enc(r.runId)}`);
  $("#run .hits").replaceChildren(...(results.length ? results.map((r) => el("a", { href: link(r) }, el("div", { class: "t" }, r.title), el("div", { class: "meta" }, `${r.kind}${r.path ? ` · ${r.path}` : ""}`), el("div", {}, r.snippet))) : [el("div", { class: "note" }, "Nothing found.")]));
}

function showPane(name) {
  const side = name === "browser" || name === "files";
  document.body.dataset.pane = side ? "side" : name;
  if (side) document.body.dataset.tab = name;
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
      if (file) viewFile(file);
      else loadFiles();
    }
    showPane(file ? "files" : "run");
  } else if (kind === "search" && id) showSearch(id);
  else {
    showNew();
    showPane("run");
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
for (const b of document.querySelectorAll(".bar button")) b.addEventListener("click", () => showPane(b.dataset.pane));
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => (document.body.dataset.tab = b.dataset.tab));
addEventListener("hashchange", route);
await loadRuns();
route();
setInterval(loadRuns, 3000);
