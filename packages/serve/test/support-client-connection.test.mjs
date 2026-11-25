// support.mjs client(): every request goes on a connection of its own, none through fetch's pool. A server closes a
// connection it has kept idle (Node's, after five seconds), and on a loaded machine that close can cross a request the
// pool sends on the same socket: the request then fails on the client ("fetch failed", read ECONNRESET) with nothing the
// server said, and the test that sent it is red for no state of the server's. The server here keeps that close's effect
// without its timing: it answers a connection's first request, and resets the connection under any later one.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { client } from "./support.mjs";

/** A server that answers each connection once, saying what it was asked, and resets a connection asked again. `asked`:
 *  each request's connection, by number. */
async function answersEachConnectionOnce(t) {
  const asked = [];
  const connections = new Map();
  const server = createServer((req, res) => {
    if (!connections.has(req.socket)) connections.set(req.socket, connections.size);
    const again = asked.includes(connections.get(req.socket));
    asked.push(connections.get(req.socket));
    if (again) return void req.socket.resetAndDestroy();
    let body = "";
    req.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => {
      if (req.url === "/v2/text") return void res.writeHead(200, { "content-type": "text/plain" }).end("not JSON");
      res.writeHead(req.url === "/v2/moved" ? 303 : 200, { "content-type": "application/json", "set-cookie": ["a=1; Path=/", "b=2; Path=/"], ...(req.url === "/v2/moved" ? { location: "/v2/elsewhere" } : {}) });
      res.end(JSON.stringify({ method: req.method, path: req.url, authorization: req.headers.authorization, type: req.headers["content-type"], body }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => (server.closeAllConnections(), new Promise((resolve) => server.close(resolve))));
  return { asked, api: client(`http://127.0.0.1:${server.address().port}/v2`, "token") };
}

test("the test client sends each request on a connection of its own: a server that resets a connection asked twice answers every one", { timeout: 30_000 }, async (t) => {
  const { asked, api } = await answersEachConnectionOnce(t);
  const answers = [];
  for (const [method, body] of [["GET"], ["POST", { n: 1 }], ["GET"], ["PATCH", { n: 2 }], ["PUT", { n: 3 }], ["DELETE"], ["GET"], ["POST"]]) answers.push(await api(method, "/things", body));
  assert.deepEqual(answers.map((answer) => answer.status), Array(8).fill(200));
  assert.deepEqual(asked, Array.from({ length: 8 }, (_, n) => n), "eight requests, eight connections");
});

test("the test client's answer reads as before: the status, the body as JSON or else its text, each header by name and every Set-Cookie apart; a body goes whole on every method, and a redirect is answered as it is", { timeout: 30_000 }, async (t) => {
  const { api } = await answersEachConnectionOnce(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { status, body } = await api(method, "/things", { text: "héllo", n: 1 });
    assert.deepEqual([status, body], [200, { method, path: "/v2/things", authorization: "Bearer token", type: "application/json", body: JSON.stringify({ text: "héllo", n: 1 }) }]);
  }
  const bare = await api("POST", "/things");
  assert.deepEqual(bare.body, { method: "POST", path: "/v2/things", authorization: "Bearer token", body: "" });
  assert.equal(bare.headers.get("content-type"), "application/json");
  assert.deepEqual(bare.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  assert.deepEqual(await api("GET", "/text").then(({ status, body }) => [status, body]), [200, "not JSON"]);
  const moved = await api("GET", "/moved");
  assert.deepEqual([moved.status, moved.headers.get("location")], [303, "/v2/elsewhere"]);
});
