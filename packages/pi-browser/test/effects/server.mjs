// Spike S3's fixture pages on loopback, counting every request to a fixture path by "METHOD /path". `hold(path)` keeps
// that path's response open until `release()`, so a test can cut a run while its request is in flight. Cross-origin
// pages use localhost against 127.0.0.1.
import http from "node:http";

/** The fixtures' own paths. Anything else on this port (another program on the box probing it) gets a 404 and is never
 * counted, so it cannot change what a test sees reach the server. */
const PATHS = new Set(["/a", "/b", "/c", "/d", "/e", "/e2", "/f", "/f-inner", "/g", "/w.js", "/api/data", "/submit", "/submit-blank",
  "/api/order", "/api/popup", "/api/iframe", "/f-form", "/api/iframe-form", "/api/put", "/api/del", "/api/beacon", "/api/worker", "/api/xorigin", "/api/loaded"]);

const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;

export async function startServer() {
  const counts = new Map();
  const held = new Set();
  const waiting = [];
  const watchers = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    let url = null;
    try { url = new URL(req.url, "http://x"); } catch { /* a request target no fixture sends */ }
    if (!url || !PATHS.has(url.pathname)) { req.resume(); res.writeHead(404); return res.end(); }
    req.resume();
    req.on("end", () => {
      const key = `${req.method} ${url.pathname}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      for (const w of watchers.splice(0)) if (!w.done()) watchers.push(w);
      const answer = () => respond(req, res, url, `http://localhost:${port}`);
      if (held.has(url.pathname)) waiting.push(answer); else answer();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    count: (key) => counts.get(key) ?? 0,
    nonGet: () => [...counts].filter(([k]) => !k.startsWith("GET ") && !k.startsWith("OPTIONS ")).flatMap(([k, n]) => Array(n).fill(k)).sort(),
    /** Resolves once the server has counted `n` requests that are not GET or OPTIONS (an event, not a delay); rejects at `ms`. */
    nonGetReached: (n, ms = 30_000) => new Promise((resolve, reject) => {
      const nonGet = () => [...counts].filter(([k]) => !k.startsWith("GET ") && !k.startsWith("OPTIONS ")).reduce((total, [, c]) => total + c, 0);
      // A wait that timed out leaves nothing behind: its watcher would otherwise run on every later request.
      const watcher = { done: () => { if (nonGet() < n) return false; clearTimeout(timer); resolve(); return true; } };
      const timer = setTimeout(() => { const at = watchers.indexOf(watcher); if (at !== -1) watchers.splice(at, 1); reject(new Error(`the server counted ${nonGet()} of ${n} expected non-GET requests in ${ms} ms`)); }, ms);
      if (!watcher.done()) watchers.push(watcher);
    }),
    reset: () => counts.clear(),
    hold: (path) => held.add(path),
    release: () => { held.clear(); for (const answer of waiting.splice(0)) answer(); },
    close: () => new Promise((resolve) => { held.clear(); waiting.length = 0; server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function respond(req, res, url, xbase) {
  const html = (s) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
  const js = (s) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(s); };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-methods": "GET,POST,PUT,DELETE", "access-control-allow-headers": "content-type" });
    return res.end();
  }
  if (req.method !== "GET") {
    if (url.pathname === "/submit" || url.pathname === "/submit-blank") return html(page("Confirmed", "<p>received</p>"));
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": req.headers.origin ?? "*" });
    return res.end("{}");
  }
  switch (url.pathname) {
    case "/a": return html(page("Page A", `<a id="to-b" href="/b">B</a>`));
    case "/b": return html(page("Page B", `<form method="POST" action="/submit"><input name="name" value="Ada"><button id="submit" type="submit">Submit</button></form>`));
    case "/c": return html(page("Page C", `<button id="order" onclick="fetch('/api/order',{method:'POST',body:JSON.stringify({qty:1})})">Order</button>`));
    case "/d": return html(page("Page D", `<script>fetch('/api/data?a=1'); fetch('/api/data?a=2');</script>`));
    case "/e": return html(page("Page E", `<button id="pop" onclick="window.open('/e2?via=open')">Open</button> <a id="blank" target="_blank" href="/e2?via=link">Link</a>`));
    case "/e2": return html(page("Popup", "<p>popup</p>", `<script>fetch('/api/popup',{method:'POST',body:'now'}); setTimeout(()=>fetch('/api/popup',{method:'POST',body:'late'}),150);</script>`));
    case "/f": return html(page("Page F", `<button id="same" onclick="add('/f-inner')">same</button> <button id="cross" onclick="add('${xbase}/f-inner')">cross</button><button id="crossform" onclick="add('${xbase}/f-form')">crossform</button><div id="slot"></div><script>function add(src){const f=document.createElement('iframe');f.src=src;document.getElementById('slot').appendChild(f);}</script>`));
    // A widget page on another origin that submits a form as soon as it loads (a payment or login widget): the form POST of a cross-origin iframe.
    case "/f-form": return html(page("Widget", `<form method="POST" action="/api/iframe-form"><input name="card" value="4111"></form>`, `<script>addEventListener("load",()=>{fetch("/api/loaded");HTMLFormElement.prototype.submit.call(document.forms[0])})</script>`));
    case "/f-inner": return html(page("Inner", "<p>inner</p>", `<script>fetch('/api/iframe',{method:'POST',body:'now'}); setTimeout(()=>fetch('/api/iframe',{method:'POST',body:'late'}),150);</script>`));
    case "/g": return html(page("Page G", `<button id="put" onclick="x('PUT','/api/put')">PUT</button><button id="del" onclick="x('DELETE','/api/del')">DELETE</button>
      <button id="beacon" onclick="navigator.sendBeacon('/api/beacon','b')">beacon</button><button id="worker" onclick="new Worker('/w.js')">worker</button>
      <button id="xorigin" onclick="fetch('${xbase}/api/xorigin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:1})})">xorigin</button>
      <form method="POST" action="/submit-blank" target="_blank"><button id="formblank" type="submit">form blank</button></form>
      <script>function x(m,u){const r=new XMLHttpRequest();r.open(m,u);r.send('p');}</script>`));
    case "/w.js": return js(`fetch('/api/worker',{method:'POST',body:'w'});`);
    case "/api/loaded":
    case "/api/data": res.writeHead(200, { "content-type": "application/json" }); return res.end("{}");
    default: res.writeHead(404); return res.end("nf");
  }
}

/** S3's twelve cases as test-driver steps, with the non-GET requests each must cause. */
export const CASES = [
  { name: "A links", steps: [{ goto: "/a" }], expected: [] },
  { name: "B form POST", steps: [{ goto: "/b" }, { click: "#submit" }, { wait: 500 }], expected: ["POST /submit"] },
  { name: "C fetch POST", steps: [{ goto: "/c" }, { click: "#order" }, { wait: 400 }], expected: ["POST /api/order"] },
  { name: "D GET only", steps: [{ goto: "/d" }, { wait: 400 }], expected: [] },
  { name: "E1 popup window.open", steps: [{ goto: "/e" }, { click: "#pop" }, { wait: 700 }], expected: ["POST /api/popup", "POST /api/popup"] },
  { name: "E2 link target=_blank", steps: [{ goto: "/e" }, { click: "#blank" }, { wait: 700 }], expected: ["POST /api/popup", "POST /api/popup"] },
  { name: "F1 same-origin iframe", steps: [{ goto: "/f" }, { click: "#same" }, { wait: 700 }], expected: ["POST /api/iframe", "POST /api/iframe"] },
  { name: "F2 cross-origin iframe", steps: [{ goto: "/f" }, { click: "#cross" }, { wait: 700 }], expected: ["POST /api/iframe", "POST /api/iframe"] },
  { name: "G1 XHR PUT, DELETE, beacon", steps: [{ goto: "/g" }, { click: "#put" }, { click: "#del" }, { click: "#beacon" }, { wait: 400 }], expected: ["DELETE /api/del", "POST /api/beacon", "PUT /api/put"] },
  { name: "G2 worker fetch POST", steps: [{ goto: "/g" }, { click: "#worker" }, { wait: 500 }], expected: ["POST /api/worker"] },
  { name: "G3 cross-origin JSON POST", steps: [{ goto: "/g" }, { click: "#xorigin" }, { wait: 500 }], expected: ["POST /api/xorigin"] },
  { name: "G4 form target=_blank", steps: [{ goto: "/g" }, { click: "#formblank" }, { wait: 700 }], expected: ["POST /submit-blank"] },
];
