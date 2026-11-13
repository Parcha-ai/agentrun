// The GitHub tests' own: a fake GitHub API (the manifest's conversion, the App's installations and installation tokens,
// a repository's installation), a server that can connect to it, the Connect flow as a browser goes through it, and a
// delivery from the App to its hook.
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { call, clientOwnerSession, serve, withEnv } from "./support.mjs";

export const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
export const PUBLIC = "https://agents.example.test";
/** Where the browser legs send the owner's browser: the console's GitHub settings (it routes by hash). */
export const CONNECTED = `${PUBLIC}/#/settings/github?github=connected`;
export const failedWith = (reason) => `${PUBLIC}/#/settings/github?github=error&reason=${reason}`;
/** The repositories the App's one installation (777, on acme) covers. */
export const INSTALLED = new Set(["acme/widgets"]);

/** A fake GitHub API: the manifest's conversion (code-1 makes the App 4242, code-2 a second App, 4343, each once), the
 *  App's installations as GitHub holds them now (`installations`: id → {account, suspended_at, repositories?}, which a
 *  test changes as GitHub would; `repositories`, the full names it covers, else 777's INSTALLED and none for another), installation tokens and a repository's installation. It keeps each request so a test reads what was
 *  asked and with which credential; `holds` keeps an answer back until a test lets it go (a conversion by its code, an
 *  installation's read by `installation` (the next one alone, answered as when asked, by `installationOnce`), the list by `installations`, which answers the list as it was when asked).
 *  `asked(prefix)` and `dropped(prefix)` settle at the next request to a path under `prefix`, or the next one its client
 *  left unanswered. */
export async function fakeGitHub(t) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: 4242, slug: "agentrun-test-app", client_id: `Iv1.${randomBytes(8).toString("hex")}`, client_secret: randomBytes(20).toString("hex"), webhook_secret: randomBytes(20).toString("hex"), pem: privateKey, tokenMs: 3600_000 };
  const second = { ...app, id: 4343, slug: "agentrun-test-app-2" };
  const byCode = new Map([["code-1", app], ["code-2", second]]);
  const installations = new Map([[777, { account: "acme", suspended_at: null }]]);
  const holds = {};
  /** An HTTP status a test makes GitHub answer: `installation` (one installation's read), `installations` (the list),
   *  `repositories` (an installation token's read of the repositories it covers), `mint` (an installation token's
   *  mint). `repositories` and `mint` also take {status, message, headers}, as GitHub's rate limits answer a 403, or a
   *  function of the installation (and, for `mint`, the body asked) giving one of those, or nothing for GitHub's answer. */
  const failures = {};
  const requests = [];
  const tokens = [];
  /** The installation tokens revoked (DELETE /installation/token), by token. */
  const revoked = [];
  // What a test waits on, never a time: a request that arrives, or one whose client went away unanswered.
  const waits = [];
  const fire = (what, url) => {
    for (const wait of waits.filter((w) => w.what === what && url.startsWith(w.prefix))) waits.splice(waits.indexOf(wait), 1), wait.resolve(url);
  };
  const next = (what) => (prefix) => new Promise((resolve) => waits.push({ what, prefix, resolve }));
  /** The full names installation `id` covers: its own list when a test gave one, else 777's INSTALLED, else none. */
  const coveredBy = (id) => new Set(installations.get(id)?.repositories ?? (id === 777 ? INSTALLED : []));
  const server = createServer((req, res) => {
    let body = "";
    res.on("close", () => !res.writableEnded && fire("dropped", req.url));
    req.on("data", (chunk) => (body += chunk)).on("end", async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      fire("asked", req.url);
      const answer = (status, doc, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(doc));
      /** A failure a test set, as its status, its message and its headers. */
      const failed = (set) => (typeof set === "object" ? [set.status, { message: set.message ?? "Server Error" }, set.headers ?? {}] : [set, { message: set === 429 ? "API rate limit exceeded" : "Server Error" }]);
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
        // `installationOnce` holds the next read alone, answering it as GitHub held the installation when it was asked: a
        // slow answer, older than now. `installation` holds every read, answered as it is when let go.
        const once = holds.installationOnce;
        delete holds.installationOnce;
        const read = () => {
          if (failures.installation) return [failures.installation, { message: "Server Error" }];
          const held = own(id).find(([key]) => key === Number(installation[1]))?.[1];
          return held ? [200, { id: Number(installation[1]), account: { login: held.account, type: "Organization" }, app_id: id, suspended_at: held.suspended_at }] : [404, { message: "Not Found" }];
        };
        if (once) {
          const asked = read();
          await once;
          return res.destroyed ? undefined : answer(...asked);
        }
        await holds.installation;
        return answer(...read());
      }
      const listing = /^\/app\/installations\?per_page=(\d+)&page=(\d+)$/.exec(req.url);
      if (req.method === "GET" && listing) {
        const id = appId();
        if (!id) return answer(401, { message: "A JSON web token could not be decoded" });
        if (failures.installations) return answer(failures.installations, { message: "Server Error" });
        const [size, page] = [Number(listing[1]), Number(listing[2])];
        // The list as GitHub held it when asked, answered once the hold (if any) lets go: a slow answer, older than now.
        const list = own(id).slice((page - 1) * size, page * size).map(([key, held]) => ({ id: key, account: { login: held.account, type: "Organization" }, app_id: id, suspended_at: held.suspended_at }));
        await holds.installations;
        if (res.destroyed) return;
        return answer(200, list);
      }
      // An installation token, narrowed to the repositories asked (by name), of those the installation covers (777's:
      // acme/widgets).
      const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url);
      if (req.method === "POST" && minting) {
        const id = appId();
        if (!id) return answer(401, { message: "A JSON web token could not be decoded" });
        const on = installations.get(Number(minting[1]));
        if (!on || (on.app_id ?? app.id) !== id) return answer(404, { message: "Not Found" });
        const asked = JSON.parse(body || "{}");
        const mintFails = typeof failures.mint === "function" ? failures.mint(Number(minting[1]), asked) : failures.mint;
        if (mintFails) return answer(...failed(mintFails));
        if ((asked.repositories ?? []).some((name) => !coveredBy(Number(minting[1])).has(`${on.account}/${name}`))) return answer(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
        const token = `ghs_test${randomBytes(18).toString("hex")}`;
        tokens.push({ token, installation: Number(minting[1]), repositories: asked.repositories, permissions: asked.permissions, at: Date.now() });
        return answer(201, { token, expires_at: new Date(Date.now() + app.tokenMs).toISOString(), permissions: { pull_requests: "write", contents: "read", metadata: "read", issues: "read" }, repository_selection: "selected" });
      }
      // An installation token's own reads: the repositories its installation covers (coveredBy), and its revoke.
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const held = tokens.find((entry) => entry.token === bearer && !revoked.includes(entry.token));
      if (req.method === "GET" && req.url.startsWith("/installation/repositories")) {
        if (!held) return answer(401, { message: "Bad credentials" });
        const listFails = typeof failures.repositories === "function" ? failures.repositories(held.installation) : failures.repositories;
        if (listFails) return answer(...failed(listFails));
        const full = [...coveredBy(held.installation)].filter((name) => !held.repositories || held.repositories.includes(name.split("/")[1]));
        return answer(200, { total_count: full.length, repositories: full.map((name) => ({ name: name.split("/")[1], full_name: name })) });
      }
      if (req.method === "DELETE" && req.url === "/installation/token") {
        if (!held) return answer(401, { message: "Bad credentials" });
        revoked.push(held.token);
        return res.writeHead(204).end();
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
  return { url: `http://127.0.0.1:${server.address().port}`, app, second, publicKey, requests, tokens, revoked, installations, holds, failures, asked: next("asked"), dropped: next("dropped") };
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
  // Connect is a secret write (it seals the App's key and webhook secret): the owner's session, as the console sends it,
  // from the public URL (its https cookie name, its origin) unless `wrong`, never the token.
  const session = await clientOwnerSession(server);
  const cookie = wrong ? session.cookie : session.cookie.replace(`agentrun-${port}-session=`, "__Host-agentrun-session=");
  const at = wrong ? { origin: session.origin } : { host: new URL(PUBLIC).host, "x-forwarded-proto": "https", origin: new URL(PUBLIC).origin };
  const res = await call(port, { method: "POST", path: "/v2/integrations/github/connect", headers: { ...at, cookie, "content-type": "application/json" }, body });
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


/** The server's store, read beside it in the runner role (the server holds the store itself): its trigger settings, its
 *  triggers and its runs' launches. Closed after the test. */
export async function storeOf(t, server) {
  const { openSqliteStore } = await import("../dist/store/index.js");
  const store = await openSqliteStore({ dataDir: server.data, role: "runner" });
  t.after(() => store.close());
  return store;
}

/** A run's first input, as its launch row holds it (the runner reads it at the run's claim). */
export async function firstInput(t, server, runId) {
  return (await (await storeOf(t, server)).runs.launch(runId)).body.input;
}
