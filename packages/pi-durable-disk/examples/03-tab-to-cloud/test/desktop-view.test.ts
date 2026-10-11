// The live view of a host's desktop: the page trades the run's secret for a short-lived ticket and shows the picture it names;
// nothing of the host's own access reaches the page. A run whose host has no desktop gets no ticket.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { CloudHost } from "../pipe/server.ts";
import { request } from "node:http";
import { localServer } from "./_local.ts";

const JPEG = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);

describe("the live view of a desktop", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base = "";
  let frames = 0;
  let hasDesktop = true;
  let calls = 0;
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    desktopFrame: async () => {
      calls++;
      return hasDesktop ? JPEG(frames++ % 250) : undefined;
    },
  };
  before(async () => {
    local = await localServer({ cloud, superviseMs: 60_000 });
    base = local.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
  });
  const ticketOf = (run: string, secret: string) => fetch(`${base}/run/${run}/desktop-ticket`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });

  it("gives a ticket for the right secret only, and the ticket's URL streams JPEG frames as multipart", async () => {
    const { id, secret } = await local.server.createRun("view");
    assert.equal((await ticketOf(id, "not-the-secret")).status, 404);
    assert.equal((await fetch(`${base}/run/${id}/desktop-ticket`, { method: "POST" })).status, 404, "no bearer token");
    assert.equal((await ticketOf("unknown-run", secret)).status, 404);
    const ok = await ticketOf(id, secret);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { url: string; ttlMs: number };
    assert.match(body.url, /^\/desktop\/[A-Za-z0-9_-]{20,}\.mjpeg$/);
    assert.ok(!JSON.stringify(body).includes(secret), "the ticket is not the secret");

    const stream = await fetch(`${base}${body.url}`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /^multipart\/x-mixed-replace; boundary=frame$/);
    const reader = stream.body!.getReader();
    let text = Buffer.alloc(0);
    while ((text.toString("latin1").match(/--frame\r\ncontent-type: image\/jpeg\r\ncontent-length: 7\r\n\r\n/g) ?? []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      text = Buffer.concat([text, Buffer.from(value)]);
    }
    await reader.cancel();
    assert.ok((text.toString("latin1").match(/--frame/g) ?? []).length >= 3, "several frames, not one");
    assert.ok(text.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "JPEG bytes");
  });

  it("one poller serves every viewer of a run, and it stops when the last one leaves", async () => {
    const { id, secret } = await local.server.createRun("many");
    const open = async () => {
      const { url } = (await (await ticketOf(id, secret)).json()) as { url: string };
      const res = await fetch(`${base}${url}`);
      return res.body!.getReader();
    };
    const readFrames = async (reader: ReadableStreamDefaultReader<Uint8Array>, n: number) => {
      let seen = 0;
      let text = "";
      while (seen < n) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("latin1");
        seen = (text.match(/--frame/g) ?? []).length;
      }
      return seen;
    };
    const a = await open();
    const b = await open();
    const before = calls;
    const [seenA, seenB] = await Promise.all([readFrames(a, 6), readFrames(b, 6)]);
    const used = calls - before;
    assert.ok(seenA >= 6 && seenB >= 6, "both viewers got pictures");
    assert.ok(used < 12, `two viewers must not cost two screenshots per tick (${used} calls for 6 frames each)`);
    await a.cancel();
    await b.cancel();
    await new Promise((r) => setTimeout(r, 600));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(calls - settled <= 1, "no viewer, no polling");
  });

  it("an unknown or malformed ticket is not found, and a run whose host has no desktop gets none", async () => {
    assert.equal((await fetch(`${base}/desktop/${"x".repeat(24)}.mjpeg`)).status, 404);
    assert.equal((await fetch(`${base}/desktop/..%2f..%2fetc.mjpeg`)).status, 404);
    const { id, secret } = await local.server.createRun("nodesk");
    hasDesktop = false;
    try {
      assert.equal((await ticketOf(id, secret)).status, 404);
    } finally {
      hasDesktop = true;
    }
  });
});

describe("a viewer that does not read its stream", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let base = "";
  let taken = 0;
  const BIG = new Uint8Array(512 * 1024).fill(0xab);
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    desktopFrame: async () => {
      taken++;
      return BIG;
    },
  };
  before(async () => {
    local = await localServer({ cloud, superviseMs: 60_000, desktopStallMs: 1_500 });
    base = local.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  });
  after(async () => {
    await local.remove();
  });

  it("is cut off once it stays backed up, and the server does not queue pictures for it", async () => {
    const { id, secret } = await local.server.createRun("stalled");
    const { url } = (await (await fetch(`${base}/run/${id}/desktop-ticket`, { method: "POST", headers: { authorization: `Bearer ${secret}` } })).json()) as { url: string };
    const req = request(`${base}${url}`, (res) => res.pause()); // a client that connects and never reads
    req.on("error", () => undefined);
    req.end();
    // While the stream lives the poller takes pictures; the stream is cut once it has been backed up for the stall time, and then, with
    // no viewer left, the polling stops. (A client that never reads does not see the close, so the server's own polling is what shows it.)
    let last = -1;
    let quiet = 0;
    const end = Date.now() + 40_000;
    while (quiet < 6) {
      if (Date.now() > end) throw new Error(`the stalled viewer was never cut off (${taken} pictures taken)`);
      await new Promise((r) => setTimeout(r, 250));
      quiet = taken === last ? quiet + 1 : 0;
      last = taken;
    }
    req.destroy();
  });
});
