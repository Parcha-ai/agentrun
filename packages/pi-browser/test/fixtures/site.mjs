// /no-content answers 204, so a navigation to it starts and never commits (as a download does) and the browser keeps
// its page.
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const fromBase32 = (text) => {
  let bits = "";
  for (const char of text.replace(/[\s=]/g, "").toUpperCase()) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
};
const toBase32 = (bytes) => [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("").match(/.{1,5}/g).map((chunk) => BASE32[parseInt(chunk.padEnd(5, "0"), 2)]).join("");

export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const REPORT_CSV = Buffer.from("quarter,revenue\nQ1,100\nQ2,140\n");
const escape = (text) => String(text).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((pair) => pair.split("=")));

function multipartFile(req, body) {
  const boundary = /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "")?.[1];
  if (!boundary) return null;
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const head = part.indexOf("\r\n\r\n");
    const name = /filename="([^"]*)"/.exec(part.slice(0, head))?.[1];
    if (head < 0 || name === undefined) continue;
    return { name, bytes: Buffer.from(part.slice(head + 4, part.lastIndexOf("\r\n")), "latin1") };
  }
  return null;
}

export async function startSite({ slowMs = 30_000, username = "fixture-user", password = randomBytes(12).toString("base64url") } = {}) {
  let submissions = 0;
  const requests = [];
  let hold = null;
  const held = [];
  const signedIn = new Set();
  const passwordPassed = new Set();
  const uploads = [];
  const secret = toBase32(randomBytes(20));
  let enrolled = false;
  let human = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://site");
      // dest is the Sec-Fetch-Dest a browser sends to 127.0.0.1; a port prober on the host and Node's fetch send none, so a
      // test that counts what reached the site counts the requests that carry it.
      requests.push({ method: req.method, path: url.pathname, cookie: req.headers.cookie ?? null, dest: req.headers["sec-fetch-dest"] ?? null });
      const body = Buffer.concat(chunks);
      const form = () => new URLSearchParams(body.toString("utf8"));
      const html = (content, headers = {}) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(`<!doctype html><html>${content}</html>`); };
      const page = (title, content, headers) => html(`<head><title>${title}</title></head><body><h1>${title}</h1>${content}</body>`, headers);
      const signIn = () => {
        const sid = randomBytes(12).toString("hex");
        signedIn.add(sid);
        res.writeHead(302, { location: "/account", "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
        res.end();
      };
      const passwordForm = (action, extra = "") => `<form id="login" method="POST" action="${action}">${extra}<label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`;
      const codeForm = (action) => `<form id="code" method="POST" action="${action}"><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>`;
      const codeOk = (code) => [-30_000, 0, 30_000].some((skew) => totp(secret, Date.now() + skew) === code);
      if (req.method === "GET" && url.pathname === "/a") return html(`<head><title>Page A</title></head><body><article><h1>Page A</h1><p>The answer is forty-two.</p></article><p><a href="/b">Go to page B</a></p></body>`);
      if (req.method === "GET" && url.pathname === "/b") return html(`<head><title>Page B</title></head><body><h1>Page B</h1><form method="POST" action="/submit"><label>Name <input name="name" type="text"></label><button type="submit">Submit</button></form></body>`);
      if (req.method === "POST" && url.pathname === "/submit") {
        submissions += 1;
        const name = form().get("name") ?? "";
        const answer = () => html(`<head><title>Confirmed</title></head><body><h1>Confirmed</h1><p id="count">Submission ${submissions} received for ${name.replace(/[<>&]/g, "")}.</p></body>`);
        if (hold) { held.push(answer); hold(); return; }
        return answer();
      }
      if (req.method === "GET" && url.pathname === "/no-content") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && url.pathname === "/slow") { setTimeout(() => html(`<head><title>Slow</title></head><body>late</body>`), slowMs); return; }

      if (req.method === "GET" && url.pathname === "/login") return page("Sign in", `<form id="login" method="POST" action="/login"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`);
      if (req.method === "POST" && url.pathname === "/login") {
        const sent = form();
        // The saved-profile tests (cdp_profiles) sign in with a bare `user`: its name becomes the cookie. `?session=1` sets a
        // SESSION cookie (no Expires, no Max-Age), like rack.session: Chrome keeps it only while it runs unless told to restore.
        if (sent.has("user") && !sent.has("username")) {
          const user = (sent.get("user") ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
          const persistent = url.searchParams.get("session") === "1" ? "" : " Max-Age=3600;";
          res.writeHead(303, { location: "/account", "set-cookie": `sid=${user};${persistent} Path=/; HttpOnly` }); res.end(); return;
        }
        if (sent.get("username") !== username || sent.get("password") !== password) return page("Sign in", `<p id="error">Wrong username or password.</p>`);
        if (!enrolled) return signIn();
        const pending = randomBytes(12).toString("hex");
        passwordPassed.add(pending);
        return page("Two-factor code", codeForm("/login/code"), { "set-cookie": `pending=${pending}; Path=/; HttpOnly` });
      }
      if (req.method === "POST" && url.pathname === "/login/code") {
        const pending = cookies(req).pending;
        if (!passwordPassed.has(pending)) return page("Sign in", `<p id="error">Sign in with your password first.</p>`);
        if (!codeOk(form().get("code"))) return page("Two-factor code", `<p id="error">That code is not right.</p>${codeForm("/login/code")}`);
        passwordPassed.delete(pending);
        return signIn();
      }
      if (req.method === "GET" && url.pathname === "/login2") return page("Sign in, step 1", `<form id="login" method="POST" action="/login2"><label>Username <input name="username" autocomplete="username"></label><button type="submit">Next</button></form>`);
      if (req.method === "POST" && url.pathname === "/login2") {
        const name = form().get("username") ?? "";
        if (name !== username) return page("Sign in, step 1", `<p id="error">No account with that username.</p>`);
        return page("Sign in, step 2", passwordForm("/login2/password", `<input type="hidden" name="username" value="${escape(name)}">`));
      }
      if (req.method === "POST" && url.pathname === "/login2/password") {
        const sent = form();
        return sent.get("username") === username && sent.get("password") === password ? signIn() : page("Sign in, step 2", `<p id="error">Wrong password.</p>`);
      }
      if (req.method === "GET" && url.pathname === "/account") {
        const sid = cookies(req).sid;
        if (signedIn.has(sid)) return page("Account", `<p id="who">Signed in as <b id="account">${escape(username)}</b></p>`);
        // A saved-profile sign-in's cookie is its user's name.
        if (sid && /^[A-Za-z0-9_.-]+$/.test(sid)) return html(`<head><title>Account</title></head><body><h1>Signed in as ${sid}</h1></body>`);
        return html(`<head><title>Account</title></head><body><h1>Signed out</h1><p id="who">Not signed in</p></body>`);
      }
      if (req.method === "GET" && url.pathname === "/totp-enrol") return page("Set up two-factor sign-in", `<p>Enter this key in your authenticator app:</p><code id="totp-secret">${secret}</code>${codeForm("/totp-enrol")}`);
      if (req.method === "POST" && url.pathname === "/totp-enrol") {
        if (!codeOk(form().get("code"))) return page("Set up two-factor sign-in", `<p id="error">That code is not right.</p>${codeForm("/totp-enrol")}`);
        enrolled = true;
        return page("Two-factor sign-in is on", `<p id="enrolled">Two-factor sign-in is on.</p>`);
      }
      if (req.method === "GET" && url.pathname === "/upload") return page("Upload", `<form id="upload" method="POST" action="/upload" enctype="multipart/form-data"><input type="file" id="file" name="file"><button type="submit">Send</button></form><p id="chosen"></p><script>
document.getElementById("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  document.getElementById("chosen").textContent = file.name + " " + file.size + " " + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
});
</script>`);
      if (req.method === "POST" && url.pathname === "/upload") {
        const file = multipartFile(req, body);
        if (!file) return page("Upload", `<p id="error">No file was sent.</p>`);
        const received = { name: file.name, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex") };
        uploads.push(received);
        return page("Received", `<p id="received">${escape(received.name)} ${received.bytes} ${received.sha256}</p>`);
      }
      if (req.method === "GET" && url.pathname === "/files") return page("Files", `<p><a id="download" href="/files/report.csv" download>Download the report</a></p>`);
      if (req.method === "GET" && url.pathname === "/files/report.csv") {
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"', "content-length": REPORT_CSV.length });
        res.end(REPORT_CSV);
        return;
      }
      // A script's el.click() is untrusted and refused; a trusted click (a person, or CDP input on their behalf) passes.
      if (req.method === "GET" && url.pathname === "/captcha") return page("Prove you are human", `<button id="human" type="button">I am not a robot</button><p id="status">Waiting for a person.</p><script>
document.getElementById("human").addEventListener("click", (event) => {
  if (!event.isTrusted) { document.getElementById("status").textContent = "Only a person can press this."; return; }
  fetch("/captcha/pass", { method: "POST" }).then(() => { document.getElementById("status").textContent = "Thanks, you are human."; });
});
</script>`);
      if (req.method === "POST" && url.pathname === "/captcha/pass") { human = true; res.writeHead(204); res.end(); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    credentials: { username, password },
    totpSecret: () => secret,
    totpEnrolled: () => enrolled,
    uploads: () => [...uploads],
    files: { "report.csv": REPORT_CSV },
    human: () => human,
    submissions: () => submissions,
    requests,
    holdSubmissions: () => new Promise((resolve) => { hold = resolve; }),
    release: () => { hold = null; for (const answer of held.splice(0)) answer(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
