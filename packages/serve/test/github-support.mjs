// The GitHub tests' own: a fake GitHub API (the manifest's conversion, the App's installations and installation tokens,
// a repository's installation), a server that can connect to it, the Connect flow as a browser goes through it, and a
// delivery from the App to its hook.
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { serve, withEnv } from "./support.mjs";

export const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
export const PUBLIC = "https://agents.example.test";
/** Where the browser legs send the owner's browser: the console's GitHub settings (it routes by hash). */
export const CONNECTED = `${PUBLIC}/#/settings/github?github=connected`;
export const failedWith = (reason) => `${PUBLIC}/#/settings/github?github=error&reason=${reason}`;
/** The repositories the App's one installation (777, on acme) covers. */
export const INSTALLED = new Set(["acme/widgets"]);

/** A fake GitHub API: the manifest's conversion (once per code) and an installation, as GitHub answers them; it keeps
 *  each request so a test reads what was asked and with which credential. */
export async function fakeGitHub(t) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: 4242, slug: "agentrun-test-app", client_id: `Iv1.${randomBytes(8).toString("hex")}`, client_secret: randomBytes(20).toString("hex"), webhook_secret: randomBytes(20).toString("hex"), pem: privateKey, tokenMs: 3600_000 };
  const requests = [];
  const tokens = [];
  const codes = new Set(["code-1"]);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url);
      if (req.method === "POST" && conversion) {
        if (!codes.delete(conversion[1])) return answer(404, { message: "Not Found" });
        return answer(201, { id: app.id, slug: app.slug, node_id: "A_1", owner: { login: "acme", type: "Organization" }, name: "AgentRun test", client_id: app.client_id, client_secret: app.client_secret, webhook_secret: app.webhook_secret, pem: app.pem });
      }
      // Every App endpoint takes only the App's JWT: RS256 over its header and claims, under the App's private key.
      const appAuthorized = () => {
        const [header, claims, signature] = String(req.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
        const verified = header && createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
        return verified && JSON.parse(Buffer.from(claims, "base64url").toString()).iss === String(app.id);
      };
      const installation = /^\/app\/installations\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && installation) {
        if (!appAuthorized()) return answer(401, { message: "A JSON web token could not be decoded" });
        if (installation[1] !== "777") return answer(404, { message: "Not Found" });
        return answer(200, { id: 777, account: { login: "acme", type: "Organization" }, app_id: app.id });
      }
      // An installation token, narrowed to the repositories asked (by name), which installation 777 holds: acme/widgets.
      const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url);
      if (req.method === "POST" && minting) {
        if (!appAuthorized()) return answer(401, { message: "A JSON web token could not be decoded" });
        if (minting[1] !== "777") return answer(404, { message: "Not Found" });
        const asked = JSON.parse(body || "{}");
        if ((asked.repositories ?? []).some((name) => !INSTALLED.has(`acme/${name}`))) return answer(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
        const token = `ghs_test${randomBytes(18).toString("hex")}`;
        tokens.push({ token, installation: Number(minting[1]), repositories: asked.repositories, at: Date.now() });
        return answer(201, { token, expires_at: new Date(Date.now() + app.tokenMs).toISOString(), permissions: { pull_requests: "write", contents: "read", metadata: "read", issues: "read" }, repository_selection: "selected" });
      }
      const covering = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(req.url);
      if (req.method === "GET" && covering) {
        if (!appAuthorized()) return answer(401, { message: "A JSON web token could not be decoded" });
        if (!INSTALLED.has(`${covering[1]}/${covering[2]}`)) return answer(404, { message: "Not Found" });
        return answer(200, { id: 777, account: { login: "acme", type: "Organization" }, app_id: app.id });
      }
      answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, app, publicKey, requests, tokens };
}

/** A server with a public URL and a seal key, its GitHub API the fake's. */
export async function connectable(t, extra = {}) {
  withEnv(t, SEAL);
  const github = await fakeGitHub(t);
  const lines = [];
  const server = await serve(t, { publicUrl: PUBLIC, githubApi: github.url, log: (line) => lines.push(line), ...extra });
  return { ...server, github, lines };
}

/** The Connect flow as the owner's browser goes through it: connect (the console posts the manifest to GitHub), GitHub's
 *  redirect back with a code, then its redirect after the App is installed. */
export async function connect(server) {
  const started = await server.api("POST", "/integrations/github/connect", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const cookie = String(started.headers.get("set-cookie") ?? "").split(";")[0];
  const back = await fetch(`${server.baseUrl}/integrations/github/callback?code=code-1&state=${started.body.state}`, { redirect: "manual", headers: { cookie } });
  assert.equal(back.status, 302, await back.text());
  const installed = await fetch(`${server.baseUrl}/integrations/github/installed?installation_id=777&setup_action=install`, { redirect: "manual" });
  assert.deepEqual([installed.status, installed.headers.get("location")], [302, CONNECTED], await installed.text());
  return { started, cookie, back, installed };
}

/** A delivery from the App: `event` with `payload`, signed with its webhook secret (or `signature` as given). */
export async function deliver(baseUrl, secret, event, payload, { signature, delivery = randomUUID() } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/hooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}` }, body });
  return { status: res.status, body: await res.json().catch(() => null), body_text: body };
}

