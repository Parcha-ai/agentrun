// The raise guard of the test client: a raise answered by a server that then goes away is the raise's answer when the
// caller opts out of the guard.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { client } from "./support.mjs";

// The guard's own read is one more request to the server. A test whose server goes away once the raise is answered (its
// follow-up's process kills it as it comes up: cap-raise's launch-kill test) opts out of it, and gets the raise's answer.
test("a raise answered by a server that then goes away is the raise's answer when the caller opts out of the raise guard", async (t) => {
  const server = createServer((req, res) => {
    // Gone once its answer is written, before any later request: as a server its follow-up's process killed.
    res.on("finish", () => setImmediate(() => (server.close(), server.closeAllConnections())));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ run_id: "r1", resumed: true, status: "queued", state: "working" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const api = client(`http://127.0.0.1:${server.address().port}`, "token");
  const raised = await api("PATCH", "/runs/r1", { max_cost_usd: 1 }, {}, { raiseCheck: false });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
});
