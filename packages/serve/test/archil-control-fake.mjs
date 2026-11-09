// A fake of Archil's control API for a disk's token users, on this machine's loopback (no call leaves it): POST
// /api/disks/{disk}/users mints a token user ({data: {token, identifier}}), DELETE /api/disks/{disk}/users/token?identifier=
// removes one (404 once it is gone). It records each request, its Authorization and body. `answer` overrides a reply
// ({status, body}) for a test that wants a refusal.
import { createServer } from "node:http";

export async function archilControlFake({ answer } = {}) {
  const requests = [];
  const users = new Map();
  let minted = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const body = raw === "" ? undefined : JSON.parse(raw);
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization, body });
      const reply = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      const forced = answer?.({ method: req.method, path: url.pathname, body });
      if (forced) return reply(forced.status, forced.body);
      const mint = /^\/api\/disks\/([^/]+)\/users$/.exec(url.pathname);
      if (req.method === "POST" && mint) {
        minted += 1;
        const user = { token: `fake-minted-token-${minted}`, identifier: `tok-${minted}`, nickname: body?.nickname, ttl: body?.ttl };
        users.set(user.identifier, user);
        return reply(201, { success: true, data: user });
      }
      const remove = /^\/api\/disks\/([^/]+)\/users\/token$/.exec(url.pathname);
      if (req.method === "DELETE" && remove) {
        const id = url.searchParams.get("identifier");
        if (!users.has(id)) return reply(404, { error: "no such user", code: "not_found" });
        users.delete(id);
        return reply(200, { success: true });
      }
      reply(404, { error: "not a fake route" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, users, close: () => new Promise((resolve) => server.close(resolve)) };
}
