// An OAuth 2.1 authorization server for tests, on loopback: RFC 8414 metadata, dynamic client registration (`/register`),
// `/authorize` that approves at once (it redirects back with a code, as a person who said yes would), and `/token` for
// the code (PKCE S256 checked) and refresh grants. Refresh tokens rotate: a used one is spent. `revoke()` spends every
// one, as a person who signs the app out does. A fake MCP server takes its access tokens with `accepts`. Every request is
// logged with its form fields, never a token's value.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const made = (prefix) => `${prefix}-${randomBytes(16).toString("hex")}`;

/** `cimd`: it says it takes client metadata documents. `clients`: pre-registered `{client_id: client_secret}`.
 *  `expiresIn`: seconds an access token lives; null, it says none. */
export async function startFakeOAuth({ cimd = false, clients = {}, expiresIn = 3600 } = {}) {
  const log = [];
  const registered = new Map(Object.entries(clients).map(([id, secret]) => [id, { secret, redirect_uris: undefined }]));
  const codes = new Map();
  const access = new Set();
  const refresh = new Map();
  const issued = [];
  let hanging = false;
  let failing = 0;
  let grantedUnanswered = false;
  /** The next `/token` request's hold (holdNext): granted at once, its answer sent when the test lets it go. */
  let holding;
  /** Who waits on the next request to a path (`next`), each with its path. */
  const nexts = [];
  /** Each RFC 7009 revocation it was sent: the hint, the client named, and whether the token was a live refresh token
   *  of its own (never the token). `revoking`: the status `/revoke` answers with, 200 unless failRevocation set one. */
  const revocations = [];
  let revoking = 200;
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, issuer());
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const form = (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
    log.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), form: Object.fromEntries(Object.entries(form).filter(([key]) => !/token|secret|code$|verifier/.test(key))) });
    for (const waiter of nexts.filter((one) => one.path === url.pathname)) nexts.splice(nexts.indexOf(waiter), 1), waiter.heard(log.at(-1));
    const json = (status, body) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/authorize`,
        token_endpoint: `${issuer()}/token`,
        registration_endpoint: `${issuer()}/register`,
        revocation_endpoint: `${issuer()}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: ["read", "write"],
        ...(cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const [id] = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent) : [form.client_id];
      const known = refresh.get(form.token)?.client_id === id;
      revocations.push({ hint: form.token_type_hint, client_id: id, known });
      if (revoking !== 200) return void res.writeHead(revoking, { "content-type": "text/plain" }).end("revocation is down");
      if (known) refresh.delete(form.token);
      return void res.writeHead(200).end();
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const client_id = made("client");
      registered.set(client_id, { redirect_uris: form.redirect_uris });
      return json(201, { ...form, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === "/authorize") {
      const q = Object.fromEntries(url.searchParams);
      const client = registered.get(q.client_id);
      const cimdClient = cimd && q.client_id?.startsWith("https://");
      if ((!client && !cimdClient) || q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) return json(400, { error: "invalid_request" });
      if (client?.redirect_uris && !client.redirect_uris.includes(q.redirect_uri)) return json(400, { error: "invalid_request", error_description: "redirect_uri" });
      const code = made("code");
      codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, scope: q.scope, resource: q.resource });
      const back = new URL(q.redirect_uri);
      back.searchParams.set("code", code);
      if (q.state) back.searchParams.set("state", q.state);
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      if (hanging) return; // never answered: its client's own timeout ends it
      if (failing) return void res.writeHead(failing, { "content-type": "text/plain" }).end("the token service is down");
      // The next one is granted (a refresh token rotated) but its answer never sent.
      const hold = holding;
      holding = undefined;
      const answer = grantedUnanswered
        ? ((grantedUnanswered = false), () => {})
        : hold
          ? (status, body) => {
              hold.granted();
              void hold.sent.then(() => json(status, body));
            }
          : json;
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const [id, secret] = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent) : [form.client_id, form.client_secret];
      const client = registered.get(id);
      if (client?.secret !== undefined && client.secret !== secret) return answer(401, { error: "invalid_client" });
      const grant = () => {
        const set = { access_token: made("access"), refresh_token: made("refresh"), token_type: "Bearer", ...(expiresIn === null ? {} : { expires_in: expiresIn }) };
        access.add(set.access_token);
        issued.push(set.access_token, set.refresh_token);
        return set;
      };
      if (form.grant_type === "authorization_code") {
        const pending = codes.get(form.code);
        codes.delete(form.code);
        const s256 = pending && createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (!pending || pending.client_id !== id || pending.redirect_uri !== form.redirect_uri || s256 !== pending.challenge) return answer(400, { error: "invalid_grant" });
        const set = grant();
        refresh.set(set.refresh_token, { client_id: id, scope: pending.scope });
        return answer(200, { ...set, ...(pending.scope ? { scope: pending.scope } : {}) });
      }
      if (form.grant_type === "refresh_token") {
        const was = refresh.get(form.refresh_token);
        refresh.delete(form.refresh_token);
        if (!was || was.client_id !== id) return answer(400, { error: "invalid_grant", error_description: "the refresh token is spent or revoked" });
        const set = grant();
        refresh.set(set.refresh_token, was);
        return answer(200, { ...set, ...(was.scope ? { scope: was.scope } : {}) });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  function issuer() {
    return `http://127.0.0.1:${http.address().port}`;
  }
  return {
    issuer: issuer(),
    log,
    /** Every access and refresh token it gave out. */
    issued,
    accepts: (authorization) => typeof authorization === "string" && access.has(authorization.replace(/^Bearer /, "")),
    revoke: () => (refresh.clear(), access.clear()),
    /** From now on `/token` never answers, as an authorization server that hangs. */
    hang: () => void (hanging = true),
    /** From now on `/token` answers `status` (a 503, say) and grants nothing, as an authorization server that is down. */
    fail: (status) => void (failing = status),
    /** Answering again: no hang, no failure. */
    heal: () => void ((hanging = false), (failing = 0)),
    /** The next `/token` request is granted (a refresh token is spent) but never answered. */
    grantUnanswered: () => void (grantedUnanswered = true),
    /** The next `/token` request is granted at once (a refresh token is spent) and its answer held: `granted` resolves
     *  once it is, and the answer leaves when `answer()` is called, as a reply still on the wire. */
    holdNext: () => {
      let granted, answer;
      const hold = { granted: new Promise((resolve) => (granted = resolve)), sent: new Promise((resolve) => (answer = resolve)) };
      holding = { granted, sent: hold.sent };
      return { granted: hold.granted, answer };
    },
    /** The next request to `path` (default `/token`) as logged, once it has reached this server: it is handled in the same
     *  turn, so a grant it makes (a refresh token spent) is made by the time the wait answers. */
    next: (path = "/token") => new Promise((heard) => nexts.push({ path, heard })),
    /** Each revocation it was sent (`/revoke`, RFC 7009), as { hint, client_id, known }, in order. */
    revocations,
    /** From now on `/revoke` answers `status` (a 503, say) and revokes nothing. */
    failRevocation: (status) => void (revoking = status),
    /** Whether `token` is a refresh token it would still take. */
    refreshable: (token) => refresh.has(token),
    /** Every access token given so far stops working, as at its expiry; refresh tokens still do. */
    expire: () => access.clear(),
    close: () => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())),
  };
}
