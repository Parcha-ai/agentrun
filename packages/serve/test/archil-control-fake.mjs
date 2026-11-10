// A fake of Archil's control API for an account's disks and each disk's token users: GET /api/disks/{disk} reads a disk
// (its id, name, region, status and authorizedUsers); POST /api/disks/{disk}/users mints a token user on that disk
// ({data: {token, identifier}}), DELETE /api/disks/{disk}/users/token?identifier= removes one of that disk's (404 once it
// is gone, or for another disk's). The account's disks: POST /api/disks {name} makes one in the fake's `region` (201,
// with a default token user, as Archil does), or answers the one of that name (200); past `limit` disks it is 403
// `disk_limit_reached` in `limitWords`; GET /api/disks lists them (`?name=` the one of that name); DELETE
// /api/disks/{id} removes one and its users (404 once gone). `disks` seeds some, each {id, name?, region?}: another
// region's for a test of the region check. `strict`: a disk the fake does not hold is 404 (default: any disk id reads
// as there, as the older tests of one disk had it). It records each request, its Authorization and body. `answer`
// overrides a reply ({status, body}) for a test that wants a refusal. `lagging`: the first list read after a mint omits
// the user it minted, as Archil's list did live (mint-4: the read right after epoch 1's mint lacked it; 15 s later it
// was there). `seen(predicate)`: a promise of the first request `predicate(request, index, requests)` holds for, made
// already or still to come, so a test awaits the request it means to read after instead of polling for it.
// `accepts(disk, token)`: whether a mount of `disk` would take `token`, as Archil decides it: a live token user of that
// disk (a user seeded with no disk belongs to every disk, as the one-disk tests had it).
//
// Two ways to reach it, one in-memory logic (controlState): archilControlFake listens on this machine's loopback (a real
// port); archilControlFetch is a fetch function with no port at all, for a test whose asserts must see every request and
// nothing else (anything on the machine can reach a port; nothing can reach a function), given through the claim's
// mountControl { baseUrl, fetch }.
import { createServer } from "node:http";

/** The fake's state and its answer to one request: { status, json }. */
function controlState({ answer, tokenOf = (n) => `fake-minted-token-${n}`, existing = [], lagging = false, region = "aws-us-east-1", disks: seeded = [], limit, limitWords, strict = false } = {}) {
  const requests = [];
  /** Every token user by identifier, each with its `disk` (none: every disk's): `existing` ones first. */
  const users = new Map(existing.map((user) => [user.identifier, { ...user }]));
  /** The account's disks by id. */
  const disks = new Map(seeded.map((disk) => [disk.id, { name: disk.id, region, status: "available", ...disk }]));
  /** With `lagging`: the users minted since the last list read, which that read leaves out. */
  const unlisted = new Set();
  let minted = 0;
  let made = 0;
  /** The awaited predicates, each with the resolve of its promise. */
  const waiting = [];
  const seen = (predicate) => {
    const found = requests.find((one, index) => predicate(one, index, requests));
    return found ? Promise.resolve(found) : new Promise((resolve) => waiting.push({ predicate, resolve }));
  };
  const onDisk = (user, disk) => user.disk === undefined || user.disk === disk;
  const accepts = (disk, token) => [...users.values()].some((user) => user.token === token && onDisk(user, disk));
  const view = (disk) => ({ id: disk.id, name: disk.name, organization: "org-fake", status: disk.status, provider: "aws", region: disk.region, createdAt: "2026-11-10T00:00:00Z", sandboxDisk: false });
  const handle = ({ method, url, authorization, body }) => {
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization, body });
    const index = requests.length - 1;
    for (const one of waiting.splice(0)) one.predicate(requests[index], index, requests) ? one.resolve(requests[index]) : waiting.push(one);
    const forced = answer?.({ method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
    if (forced) return { status: forced.status, json: forced.body };
    const diskPath = /^\/api\/disks\/([^/]+)/.exec(url.pathname);
    const diskId = diskPath ? decodeURIComponent(diskPath[1]) : undefined;
    if (diskId !== undefined && strict && !disks.has(diskId)) return { status: 404, json: { success: false, error: `disk ${diskId} not found`, code: "not_found" } };
    if (method === "POST" && url.pathname === "/api/disks") {
      const there = [...disks.values()].find((disk) => disk.name === body?.name);
      if (there) return { status: 200, json: { success: true, data: { diskId: there.id, authorizedUsers: [] } } };
      if (limit !== undefined && [...disks.values()].filter((disk) => disk.region === region).length >= limit) {
        return { status: 403, json: { success: false, error: limitWords ?? `disk limit reached: your plan allows ${limit} disks per region`, code: "disk_limit_reached" } };
      }
      made += 1;
      const id = `dsk-${made.toString(16).padStart(16, "a")}`;
      disks.set(id, { id, name: body?.name, region, status: "available" });
      minted += 1;
      const user = { type: "token", token: tokenOf(minted), identifier: `default-${minted}`, nickname: "default", disk: id };
      users.set(user.identifier, user);
      return { status: 201, json: { success: true, data: { diskId: id, authorizedUsers: [{ type: "token", identifier: user.identifier, token: user.token, nickname: user.nickname }] } } };
    }
    if (method === "GET" && url.pathname === "/api/disks") {
      const name = url.searchParams.get("name");
      const listed = [...disks.values()].filter((disk) => name === null || disk.name === name);
      return { status: 200, json: { success: true, data: listed.map(view), total: listed.length } };
    }
    if (method === "GET" && /^\/api\/disks\/[^/]+$/.test(url.pathname)) {
      const listed = [...users.values()].filter((user) => onDisk(user, diskId) && !unlisted.has(user.identifier));
      unlisted.clear();
      const disk = disks.get(diskId);
      return { status: 200, json: { success: true, data: { ...(disk ? view(disk) : {}), authorizedUsers: listed.map(({ identifier, nickname }) => ({ type: "token", identifier, nickname })) } } };
    }
    if (method === "DELETE" && /^\/api\/disks\/[^/]+$/.test(url.pathname)) {
      if (!disks.has(diskId)) return { status: 404, json: { success: false, error: `disk ${diskId} not found`, code: "not_found" } };
      disks.delete(diskId);
      for (const [id, user] of users) if (user.disk === diskId) users.delete(id);
      return { status: 200, json: { success: true } };
    }
    if (method === "POST" && /^\/api\/disks\/([^/]+)\/users$/.test(url.pathname)) {
      minted += 1;
      const user = { token: tokenOf(minted), identifier: `tok-${minted}`, nickname: body?.nickname, ttl: body?.ttl, disk: diskId };
      users.set(user.identifier, user);
      if (lagging) unlisted.add(user.identifier);
      const { disk: _disk, ...shown } = user;
      return { status: 201, json: { success: true, data: shown } };
    }
    if (method === "DELETE" && /^\/api\/disks\/([^/]+)\/users\/token$/.test(url.pathname)) {
      const id = url.searchParams.get("identifier");
      const user = users.get(id);
      if (!user || !onDisk(user, diskId)) return { status: 404, json: { error: "no such user", code: "not_found" } };
      users.delete(id);
      return { status: 200, json: { success: true } };
    }
    return { status: 404, json: { error: "not a fake route" } };
  };
  return { requests, users, disks, handle, seen, accepts };
}

/** The fake on this machine's loopback: its `baseUrl`, the requests it saw, its users and disks, `seen`, `accepts` and
 *  `close`. */
export async function archilControlFake(options = {}) {
  const { requests, users, disks, handle, seen, accepts } = controlState(options);
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
  return { baseUrl, requests, users, disks, seen, accepts, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The fake as a fetch function, no port: `fetch` answers every request whatever its host (give `baseUrl` as the
 *  claim's control plane), and `requests` records each one, so a count of zero means none was made. */
export function archilControlFetch(options = {}) {
  const { requests, users, disks, handle, seen, accepts } = controlState(options);
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const { status, json } = handle({ method: request.method, url: new URL(request.url), authorization: request.headers.get("authorization") ?? undefined, body: raw === "" ? undefined : JSON.parse(raw) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { baseUrl: "https://control.test", fetch, requests, users, disks, seen, accepts };
}
