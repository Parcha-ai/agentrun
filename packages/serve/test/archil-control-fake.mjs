// A fake of Archil's control API for a disk's token users: GET /api/disks/{disk} lists them (its authorizedUsers); POST
// /api/disks/{disk}/users mints a token user ({data: {token, identifier}}), DELETE /api/disks/{disk}/users/token?identifier=
// removes one (404 once it is gone). It records each request, its Authorization and body. `answer` overrides a reply
// ({status, body}) for a test that wants a refusal. `lagging`: the first list read after a mint omits the user it minted,
// as Archil's list did live (mint-4: the read right after epoch 1's mint lacked it; 15 s later it was there).
//
// Two ways to reach it, one in-memory logic (controlState): archilControlFake listens on this machine's loopback (a real
// port); archilControlFetch is a fetch function with no port at all, for a test whose asserts must see every request and
// nothing else (anything on the machine can reach a port; nothing can reach a function), given through the claim's
// mountControl { baseUrl, fetch }.
import { createServer } from "node:http";

/** The fake's state and its answer to one request: { status, json }. */
function controlState({ answer, tokenOf = (n) => `fake-minted-token-${n}`, existing = [], lagging = false } = {}) {
  const requests = [];
  /** The disk's token users by identifier: `existing` ones first (an earlier claim's, another run's). */
  const users = new Map(existing.map((user) => [user.identifier, { ...user }]));
  /** With `lagging`: the users minted since the last list read, which that read leaves out. */
  const unlisted = new Set();
  let minted = 0;
  const handle = ({ method, url, authorization, body }) => {
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization, body });
    const forced = answer?.({ method, path: url.pathname, body });
    if (forced) return { status: forced.status, json: forced.body };
    if (method === "GET" && /^\/api\/disks\/[^/]+$/.test(url.pathname)) {
      const listed = [...users.values()].filter((user) => !unlisted.has(user.identifier));
      unlisted.clear();
      return { status: 200, json: { success: true, data: { authorizedUsers: listed.map(({ identifier, nickname }) => ({ type: "token", identifier, nickname })) } } };
    }
    if (method === "POST" && /^\/api\/disks\/([^/]+)\/users$/.test(url.pathname)) {
      minted += 1;
      const user = { token: tokenOf(minted), identifier: `tok-${minted}`, nickname: body?.nickname, ttl: body?.ttl };
      users.set(user.identifier, user);
      if (lagging) unlisted.add(user.identifier);
      return { status: 201, json: { success: true, data: user } };
    }
    if (method === "DELETE" && /^\/api\/disks\/([^/]+)\/users\/token$/.test(url.pathname)) {
      const id = url.searchParams.get("identifier");
      if (!users.has(id)) return { status: 404, json: { error: "no such user", code: "not_found" } };
      users.delete(id);
      return { status: 200, json: { success: true } };
    }
    return { status: 404, json: { error: "not a fake route" } };
  };
  return { requests, users, handle };
}

/** The fake on this machine's loopback: its `baseUrl`, the requests it saw, its users, and `close`. */
export async function archilControlFake(options = {}) {
  const { requests, users, handle } = controlState(options);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const { status, json } = handle({ method: req.method, url: new URL(req.url, "http://fake"), authorization: req.headers.authorization, body: raw === "" ? undefined : JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, users, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The fake as a fetch function, no port: `fetch` answers every request whatever its host (give `baseUrl` as the
 *  claim's control plane), and `requests` records each one, so a count of zero means none was made. */
export function archilControlFetch(options = {}) {
  const { requests, users, handle } = controlState(options);
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const { status, json } = handle({ method: request.method, url: new URL(request.url), authorization: request.headers.get("authorization") ?? undefined, body: raw === "" ? undefined : JSON.parse(raw) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { baseUrl: "https://control.test", fetch, requests, users };
}
