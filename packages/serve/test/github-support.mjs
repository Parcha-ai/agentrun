// The GitHub tests' own: a fake GitHub API (the manifest's conversion, the App's installations and installation tokens,
// a repository's installation), a server that can connect to it, the Connect flow as a browser goes through it, and a
// delivery from the App to its hook.
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { call, serve, withEnv } from "./support.mjs";

export const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
export const PUBLIC = "https://agents.example.test";
/** Where the browser legs send the owner's browser: the console's GitHub settings (it routes by hash). */
export const CONNECTED = `${PUBLIC}/#/settings/github?github=connected`;
export const failedWith = (reason) => `${PUBLIC}/#/settings/github?github=error&reason=${reason}`;
/** The repositories the App's one installation (777, on acme) covers. */
export const INSTALLED = new Set(["acme/widgets"]);

/** A fake GitHub API: the manifest's conversion (code-1 makes the App 4242, code-2 a second App, 4343, each once), the
 *  App's installations as GitHub holds them now (`installations`: id → {account, suspended_at}, which a test changes as
 *  GitHub would), installation tokens and a repository's installation. It keeps each request so a test reads what was
 *  asked and with which credential; `holds` keeps an answer back until a test lets it go (a conversion by its code, an
 *  installation's read by `installation`). */
export async function fakeGitHub(t) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: 4242, slug: "agentrun-test-app", client_id: `Iv1.${randomBytes(8).toString("hex")}`, client_secret: randomBytes(20).toString("hex"), webhook_secret: randomBytes(20).toString("hex"), pem: privateKey, tokenMs: 3600_000 };
  const second = { ...app, id: 4343, slug: "agentrun-test-app-2" };
  const byCode = new Map([["code-1", app], ["code-2", second]]);
  const installations = new Map([[777, { account: "acme", suspended_at: null }]]);
  const holds = {};
  /** An HTTP status a test makes GitHub answer: `installation` (one installation's read), `installations` (the list). */
  const failures = {};
  const requests = [];
  const tokens = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url);
      if (req.method === "POST" && conversion) {
        const made = byCode.get(conversion[1]);
        if (!made) return answer(404, { message: "Not Found" });
        byCode.delete(conversion[1]);
        await holds[conversion[1]];
        return answer(201, { id: made.id, slug: made.slug, node_id: "A_1", owner: { login: "acme", type: "Organization" }, name: "AgentRun test", client_id: made.client_id, client_secret: made.client_secret, webhook_secret: made.webhook_secret, pem: made.pem });
      }
      // Every App endpoint takes only an App's JWT: RS256 over its header and claims, under the App's private key.
      const appId = () => {
        const [header, claims, signature] = String(req.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
        const verified = header && createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
        const iss = verified ? Number(JSON.parse(Buffer.from(claims, "base64url").toString()).iss) : undefined;
        return iss === app.id || iss === second.id ? iss : undefined;
      };
      // Each installation is one App's (4242 unless it says): an App sees only its own.
      const own = (id) => [...installations].filter(([, held]) => (held.app_id ?? app.id) === id);
      const installation = /^\/app\/installations\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && installation) {
        const id = appId();
        if (!id) return answer(401, { message: "A JSON web token could not be decoded" });
        await holds.installation;
        if (failures.installation) return answer(failures.installation, { message: "Server Error" });
        const held = own(id).find(([key]) => key === Number(installation[1]))?.[1];
        if (!held) return answer(404, { message: "Not Found" });
        return answer(200, { id: Number(installation[1]), account: { login: held.account, type: "Organization" }, app_id: id, suspended_at: held.suspended_at });
      }
      const listing = /^\/app\/installations\?per_page=(\d+)&page=(\d+)$/.exec(req.url);
      if (req.method === "GET" && listing) {
        const id = appId();
        if (!id) return answer(401, { message: "A JSON web token could not be decoded" });
        if (failures.installations) return answer(failures.installations, { message: "Server Error" });
        const [size, page] = [Number(listing[1]), Number(listing[2])];
        return answer(200, own(id).slice((page - 1) * size, page * size).map(([key, held]) => ({ id: key, account: { login: held.account, type: "Organization" }, app_id: id, suspended_at: held.suspended_at })));
      }
      // An installation token, narrowed to the repositories asked (by name), which installation 777 holds: acme/widgets.
      const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url);
      if (req.method === "POST" && minting) {
        if (!appId()) return answer(401, { message: "A JSON web token could not be decoded" });
        if (minting[1] !== "777" || !installations.has(777)) return answer(404, { message: "Not Found" });
        const asked = JSON.parse(body || "{}");
        if ((asked.repositories ?? []).some((name) => !INSTALLED.has(`acme/${name}`))) return answer(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
        const token = `ghs_test${randomBytes(18).toString("hex")}`;
        tokens.push({ token, installation: Number(minting[1]), repositories: asked.repositories, at: Date.now() });
        return answer(201, { token, expires_at: new Date(Date.now() + app.tokenMs).toISOString(), permissions: { pull_requests: "write", contents: "read", metadata: "read", issues: "read" }, repository_selection: "selected" });
      }
      const covering = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(req.url);
      if (req.method === "GET" && covering) {
        const id = appId();
        if (!id) return answer(401, { message: "A JSON web token could not be decoded" });
        if (!INSTALLED.has(`${covering[1]}/${covering[2]}`)) return answer(404, { message: "Not Found" });
        return answer(200, { id: 777, account: { login: "acme", type: "Organization" }, app_id: id });
      }
      answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}`, app, second, publicKey, requests, tokens, installations, holds, failures };
}

/** A promise and the function that settles it: a hold a test lets go. */
export function held() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/** POST /v2/integrations/github/connect from the console at the server's public URL (its Host and https, as a proxy in
 *  front gives them), the address GitHub sends the browser back to; `wrong` sends it to the address the server listens
 *  on instead. Answers as the API client does: status, JSON body, headers.get. */
export async function startConnect(server, body = {}, { wrong = false } = {}) {
  const port = Number(new URL(server.baseUrl).port);
  const res = await call(port, { method: "POST", path: "/v2/integrations/github/connect", headers: { ...(wrong ? {} : { host: new URL(PUBLIC).host, "x-forwarded-proto": "https" }), authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body });
  return { status: res.status, body: res.json ?? res.text, headers: { get: (name) => [res.headers[name] ?? []].flat().join(", ") || null } };
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
  const started = await startConnect(server);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const cookie = String(started.headers.get("set-cookie") ?? "").split(";")[0];
  const back = await callback(server, "code-1", started.body.state, cookie);
  const installed = await install(server, 777, back);
  assert.deepEqual([installed.status, installed.headers.get("location")], [302, CONNECTED], await installed.text());
  return { started, cookie, back, installed };
}

/** GitHub's redirect back with `code`, from the browser holding `cookie`: its answer, and the install state the server
 *  sends on to GitHub's install page (in its Location) with the cookie it sets for it. */
export async function callback(server, code, state, cookie) {
  const res = await fetch(`${server.baseUrl}/integrations/github/callback?code=${code}&state=${state}`, { redirect: "manual", headers: { cookie } });
  const location = res.headers.get("location") ?? "";
  const installState = URL.canParse(location) ? new URL(location).searchParams.get("state") : null;
  const installCookie = res.headers.getSetCookie().map((line) => line.split(";")[0]).find((pair) => !pair.endsWith("=")) ?? "";
  return { res, status: res.status, location, installState, installCookie };
}

/** GitHub's redirect after the App is installed: installation `id`, with the install state and cookie of `back` (a
 *  callback's), or as given. */
export function install(server, id, back = {}, { state = back.installState, cookie = back.installCookie } = {}) {
  return fetch(`${server.baseUrl}/integrations/github/installed?installation_id=${id}&setup_action=install${state ? `&state=${state}` : ""}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

/** A delivery from the App: `event` with `payload`, signed with its webhook secret (or `signature` as given). */
export async function deliver(baseUrl, secret, event, payload, { signature, delivery = randomUUID() } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/hooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}` }, body });
  return { status: res.status, body: await res.json().catch(() => null), body_text: body };
}

