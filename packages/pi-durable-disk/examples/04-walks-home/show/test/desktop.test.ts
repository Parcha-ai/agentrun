import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { desktopTargetFromLink, proxyStream, requestTicket, TICKET_PATH, type DesktopTarget } from "../desktop.ts";

const SECRET = "run-secret-value-123456";
const TICKET = "tkt_abcdefghijklmnopqrstuvwx";

describe("the live view of a desktop", () => {
  let host: Server;
  let target: DesktopTarget;
  const calls: { method: string; url: string; auth?: string }[] = [];
  let streamClosed = false;
  let hasDesktop = true;

  before(async () => {
    host = createServer((req: IncomingMessage, res) => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      if (req.method === "POST" && req.url === "/run/stage/desktop-ticket") {
        if (req.headers.authorization !== `Bearer ${SECRET}` || !hasDesktop) return void res.writeHead(404).end();
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: `/desktop/${TICKET}.mjpeg`, ttlMs: 600000 }));
      }
      if (req.method === "GET" && req.url === `/desktop/${TICKET}.mjpeg`) {
        res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
        res.write("--frame\r\ncontent-type: image/jpeg\r\ncontent-length: 4\r\n\r\nAAAA\r\n");
        req.on("close", () => (streamClosed = true));
        const t = setInterval(() => res.write("--frame\r\ncontent-type: image/jpeg\r\ncontent-length: 4\r\n\r\nBBBB\r\n"), 20);
        req.on("close", () => clearInterval(t));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    target = desktopTargetFromLink(`http://127.0.0.1:${(host.address() as { port: number }).port}/run/stage#${SECRET}`);
  });
  after(() => host.close());

  it("reads the host, the run and the secret from a run link", () => {
    assert.equal(target.run, "stage");
    assert.equal(target.secret, SECRET);
    assert.match(target.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("trades the secret for a ticket path, sending it as a bearer token and returning no secret", async () => {
    const t = await requestTicket(target);
    assert.deepEqual(t, { ok: true, url: `/desktop/${TICKET}.mjpeg`, ttlMs: 600000 });
    assert.equal(calls.at(-1)!.auth, `Bearer ${SECRET}`);
    assert.ok(!JSON.stringify(t).includes(SECRET));
  });

  it("a wrong secret, or a host with no desktop, is a 404 and no ticket", async () => {
    assert.deepEqual(await requestTicket({ ...target, secret: "wrong" }), { ok: false, status: 404 });
    hasDesktop = false;
    assert.deepEqual(await requestTicket(target), { ok: false, status: 404 });
    hasDesktop = true;
  });

  it("refuses a ticket url that is not a desktop stream, whatever the host claims", async () => {
    const lying: typeof fetch = async () => new Response(JSON.stringify({ url: "/run/stage/../../admin/kill", ttlMs: 1 }), { status: 200 });
    assert.deepEqual(await requestTicket(target, lying), { ok: false, status: 502 });
  });

  it("only forwards a ticket stream path", () => {
    assert.ok(TICKET_PATH.test(`/desktop/${TICKET}.mjpeg`));
    for (const bad of ["/run/stage/desktop-ticket", "/desktop/../x.mjpeg", "/desktop/a.mjpeg", `/desktop/${TICKET}.mjpeg/extra`, "/admin/kill-cloud", `//evil/desktop/${TICKET}.mjpeg`]) assert.ok(!TICKET_PATH.test(bad), bad);
  });

  it("streams the host's frames to the page with their multipart type, sends no credential, and stops pulling when the page closes", async () => {
    const proxy = createServer((req, res) => void proxyStream(target, (req.url ?? "").split("?")[0]!, req, res));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const port = (proxy.address() as { port: number }).port;
    const before = calls.length;
    streamClosed = false;
    const got = await new Promise<{ type: string; body: string; status: number }>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: `/desktop/${TICKET}.mjpeg` }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.includes("BBBB")) {
            resolve({ type: String(res.headers["content-type"]), body, status: res.statusCode ?? 0 });
            req.destroy();
          }
        });
      });
      req.end();
    });
    assert.equal(got.status, 200);
    assert.match(got.type, /^multipart\/x-mixed-replace; boundary=frame$/);
    assert.ok(got.body.includes("AAAA") && got.body.includes("BBBB"));
    assert.equal(calls.slice(before).filter((c) => c.auth).length, 0, "the stream request carries no bearer token");
    for (let i = 0; i < 50 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(streamClosed, "the host's stream was closed when the page's was");
    const refused = await fetch(`http://127.0.0.1:${port}/run/stage/desktop-ticket`);
    assert.equal(refused.status, 400);
    proxy.close();
  });
});
