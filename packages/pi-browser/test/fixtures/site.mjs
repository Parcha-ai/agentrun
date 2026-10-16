// /no-content answers 204, so a navigation to it starts and never commits (as a download does) and the browser keeps
// its page.
import http from "node:http";

export async function startSite({ slowMs = 30_000 } = {}) {
  let submissions = 0;
  const requests = [];
  let hold = null;
  const held = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://site");
      requests.push({ method: req.method, path: url.pathname, cookie: req.headers.cookie ?? null });
      const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><html>${body}</html>`); };
      if (req.method === "GET" && url.pathname === "/a") return html(`<head><title>Page A</title></head><body><article><h1>Page A</h1><p>The answer is forty-two.</p></article><p><a href="/b">Go to page B</a></p></body>`);
      if (req.method === "GET" && url.pathname === "/b") return html(`<head><title>Page B</title></head><body><h1>Page B</h1><form method="POST" action="/submit"><label>Name <input name="name" type="text"></label><button type="submit">Submit</button></form></body>`);
      if (req.method === "POST" && url.pathname === "/submit") {
        submissions += 1;
        const name = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("name") ?? "";
        const answer = () => html(`<head><title>Confirmed</title></head><body><h1>Confirmed</h1><p id="count">Submission ${submissions} received for ${name.replace(/[<>&]/g, "")}.</p></body>`);
        if (hold) { held.push(answer); hold(); return; }
        return answer();
      }
      if (req.method === "GET" && url.pathname === "/login") return html(`<head><title>Sign in</title></head><body><h1>Sign in</h1><form method="POST" action="/login"><label>User <input name="user" type="text"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form></body>`);
      if (req.method === "POST" && url.pathname === "/login") {
        const user = (new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("user") ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
        // `?session=1` sets a SESSION cookie (no Expires, no Max-Age), like rack.session: Chrome keeps it only while it runs unless it is told to restore the session.
        const persistent = url.searchParams.get("session") === "1" ? "" : " Max-Age=3600;";
        res.writeHead(303, { location: "/account", "set-cookie": `sid=${user};${persistent} Path=/; HttpOnly` }); res.end(); return;
      }
      if (req.method === "GET" && url.pathname === "/account") {
        const who = /(?:^|;\s*)sid=([A-Za-z0-9_.-]+)/.exec(req.headers.cookie ?? "")?.[1];
        return who ? html(`<head><title>Account</title></head><body><h1>Signed in as ${who}</h1></body>`) : html(`<head><title>Account</title></head><body><h1>Signed out</h1></body>`);
      }
      if (req.method === "GET" && url.pathname === "/no-content") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && url.pathname === "/slow") { setTimeout(() => html(`<head><title>Slow</title></head><body>late</body>`), slowMs); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    submissions: () => submissions,
    requests,
    holdSubmissions: () => new Promise((resolve) => { hold = resolve; }),
    release: () => { hold = null; for (const answer of held.splice(0)) answer(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
