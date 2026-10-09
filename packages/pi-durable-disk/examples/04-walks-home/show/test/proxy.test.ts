import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The stage in proxy mode (SHOW_API) in front of a fake live feed. The page fetches /api/state, reads its x-last-event-id,
// and resumes the event stream after that index; a proxy that drops the header makes the page replay events its snapshot
// already holds, and every narration line shows twice.
const serve = fileURLToPath(new URL("../serve.ts", import.meta.url));

describe("the stage proxying a live feed", () => {
  let upstream: Server;
  let child: ChildProcess;
  let port = 0;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

  before(async () => {
    upstream = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      if (req.url?.startsWith("/api/state")) {
        res.writeHead(200, { "content-type": "application/json", "x-last-event-id": "7" });
        res.end(JSON.stringify({ run: "fake" }));
      } else if (req.url?.startsWith("/api/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('id: 8\ndata: {"t":"note"}\n\n');
        res.end();
      } else if (req.method === "POST" && req.url === "/api/command") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "no" }));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    port = 19000 + Math.floor(Math.random() * 900);
    child = spawn(process.execPath, [serve], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SHOW_PORT: String(port), SHOW_API: `http://127.0.0.1:${upstreamPort}` }, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the stage did not start");
  });
  after(() => {
    child.kill();
    upstream.close();
  });

  it("passes the snapshot's event index through, so the page resumes after it", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.headers.get("x-last-event-id"), "7");
  });

  it("passes a resume point to the feed's event stream, and the feed's refusals back with their status", async () => {
    const events = await fetch(`http://127.0.0.1:${port}/api/events?after=7`, { headers: { "last-event-id": "7" } });
    assert.match(await events.text(), /id: 8/);
    const last = seen.filter((s) => s.url.startsWith("/api/events")).at(-1)!;
    assert.equal(last.headers["last-event-id"], "7");
    assert.match(last.url, /after=7/);
    const refused = await fetch(`http://127.0.0.1:${port}/api/command`, { method: "POST", body: JSON.stringify({ t: "fanout" }) });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, message: "no" });
  });
});
