// A fake of Archil's control API for a disk's token users: GET /api/disks/{disk} lists them (its authorizedUsers); POST
// /api/disks/{disk}/users mints a token user ({data: {token, identifier}}), DELETE /api/disks/{disk}/users/token?identifier=
// removes one (404 once it is gone). It records each request, its Authorization and body. `answer` overrides a reply
// ({status, body}) for a test that wants a refusal. `lagging`: the list reads after a mint omit the user it minted, the
// first one (`true`) or the first n (a number; Infinity until `settle()`), as Archil's list did live (mint-4: the read
// right after epoch 1's mint lacked it, the read after epoch 2's POST held both, and 15 s later it was there).
// `seen(predicate)`: a promise of the first request `predicate(request, index, requests)` holds for, made already or still
// to come, so a test awaits the request it means to read after instead of polling for it.
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
  /** With `lagging`: each user minted, by identifier, and how many more list reads leave it out. */
  const unlisted = new Map();
  const reads = lagging === true ? 1 : Number(lagging) || 0;
  let minted = 0;
  /** The awaited predicates, each with the resolve of its promise. */
  const waiting = [];
  const seen = (predicate) => {
    const found = requests.find((one, index) => predicate(one, index, requests));
    return found ? Promise.resolve(found) : new Promise((resolve) => waiting.push({ predicate, resolve }));
  };
  const handle = ({ method, url, authorization, body }) => {
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization, body });
    const index = requests.length - 1;
    for (const one of waiting.splice(0)) one.predicate(requests[index], index, requests) ? one.resolve(requests[index]) : waiting.push(one);
    const forced = answer?.({ method, path: url.pathname, body });
    if (forced) return { status: forced.status, json: forced.body };
    if (method === "GET" && /^\/api\/disks\/[^/]+$/.test(url.pathname)) {
      const listed = [...users.values()].filter((user) => !unlisted.has(user.identifier));
      for (const [id, left] of unlisted) left <= 1 ? unlisted.delete(id) : unlisted.set(id, left - 1);
      return { status: 200, json: { success: true, data: { authorizedUsers: listed.map(({ identifier, nickname }) => ({ type: "token", identifier, nickname })) } } };
    }
    if (method === "POST" && /^\/api\/disks\/([^/]+)\/users$/.test(url.pathname)) {
      minted += 1;
      const user = { token: tokenOf(minted), identifier: `tok-${minted}`, nickname: body?.nickname, ttl: body?.ttl };
      users.set(user.identifier, user);
      if (reads > 0) unlisted.set(user.identifier, reads);
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
  /** The lag over: every list read from now on holds every user. */
  const settle = () => unlisted.clear();
  return { requests, users, handle, settle, seen };
}

/** The fake on this machine's loopback: its `baseUrl`, the requests it saw, its users, `settle` and `close`. */
export async function archilControlFake(options = {}) {
  const { requests, users, handle, settle, seen } = controlState(options);
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
  return { baseUrl, requests, users, settle, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The fake as a fetch function, no port: `fetch` answers every request whatever its host (give `baseUrl` as the
 *  claim's control plane), and `requests` records each one, so a count of zero means none was made. */
export function archilControlFetch(options = {}) {
  const { requests, users, handle, settle, seen } = controlState(options);
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const { status, json } = handle({ method: request.method, url: new URL(request.url), authorization: request.headers.get("authorization") ?? undefined, body: raw === "" ? undefined : JSON.parse(raw) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { baseUrl: "https://control.test", fetch, requests, users, settle, seen };
}
