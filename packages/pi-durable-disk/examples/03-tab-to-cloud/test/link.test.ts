// A cloud host's link: the host listens, the server dials in with a bearer token, and the host's model calls reach the
// model endpoint through the server's ModelProxy (its budget counts them). A wrong token is refused.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { drainTrail, startCloudLink, type CloudLink } from "../cloud-link.ts";
import { dialLink, type LinkDialer } from "../pipe/link.ts";
import { ModelProxy } from "../pipe/model-proxy.ts";
import { modelStub } from "./_local.ts";

const PORT = 18795;

describe("the cloud link", () => {
  let model: Awaited<ReturnType<typeof modelStub>>;
  let link: CloudLink;
  let dialer: LinkDialer | undefined;
  before(async () => {
    model = await modelStub(() => "from the server's model");
    link = await startCloudLink({ port: PORT, host: "127.0.0.1", token: "right-token", waitMs: 3_000 });
  });
  after(async () => {
    dialer?.close();
    await link.close();
    await model.close();
  });

  it("refuses a dialer with the wrong token, so the host's calls find no link", async () => {
    const bad = dialLink({ url: `ws://127.0.0.1:${PORT}/`, token: "wrong", proxy: new ModelProxy({ baseUrl: model.url, model: "m", budgetTokens: 100 }), log: () => undefined, retryMs: 60_000 });
    const res = await fetch(`${link.baseUrl}/responses`, { method: "POST", body: JSON.stringify({ input: "hi" }) });
    assert.equal(res.status, 503);
    bad.close();
  });

  it("carries the host's model calls through the server's proxy and its budget", async () => {
    const proxy = new ModelProxy({ baseUrl: model.url, model: "server-model", budgetTokens: 100 });
    dialer = dialLink({ url: `ws://127.0.0.1:${PORT}/`, token: "right-token", proxy, log: () => undefined });
    const res = await fetch(`${link.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "host-asks-for-another", messages: [] }) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /from the server's model/);
    assert.equal(model.requests.at(-1)!.model, "server-model");
    assert.equal(proxy.spent, 15);
  });
});

describe("the GPU boxes over the cloud link", () => {
  const PORT2 = 18796;
  let model: Awaited<ReturnType<typeof modelStub>>;
  let link: CloudLink;
  const dialers: LinkDialer[] = [];
  before(async () => {
    model = await modelStub(() => "x");
    link = await startCloudLink({ port: PORT2, host: "127.0.0.1", token: "tok", waitMs: 3_000 });
  });
  after(async () => {
    for (const d of dialers) d.close();
    await link.close();
    await model.close();
  });
  const proxy = () => new ModelProxy({ baseUrl: model.url, model: "m", budgetTokens: 100 });
  const enc = (s: string) => new TextEncoder().encode(s);
  async function* once(s: string) {
    yield enc(s);
  }
  const until = async (check: () => boolean) => {
    for (const end = Date.now() + 5_000; !check(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error("timed out");
  };

  it("a host with no boxes from the server is refused cleanly, and one with boxes runs a command through the link", async () => {
    const plain = dialLink({ url: `ws://127.0.0.1:${PORT2}/`, token: "tok", proxy: proxy(), log: () => undefined, retryMs: 100 });
    dialers.push(plain);
    await until(() => true);
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(link.gpu.acquire("t1"), /no GPU boxes/);
    plain.close();
    await new Promise((r) => setTimeout(r, 200));
    const held = new Set<string>();
    const gpu = dialLink({
      url: `ws://127.0.0.1:${PORT2}/`,
      token: "tok",
      proxy: proxy(),
      log: () => undefined,
      retryMs: 100,
      gpu: {
        acquire: async (thread) => (held.add("box-9"), `box-9:${thread}`),
        release: () => undefined,
        holds: (box) => box.startsWith("box-9"),
        exec: async (_box, argv) => ({ stdin: { writeBytes: async () => undefined, close: async () => undefined }, stdout: once(`ran ${argv.join(" ")}`), stderr: once(""), wait: async () => 0 }),
        poll: async () => null,
      },
    });
    dialers.push(gpu);
    await until(() => true);
    let box = "";
    for (const end = Date.now() + 5_000; !box; await new Promise((r) => setTimeout(r, 100))) {
      if (Date.now() > end) throw new Error("the host never got its box");
      box = await link.gpu.acquire("t2").catch(() => "");
    }
    const p = await link.gpu.linkBox(box).exec(["echo", "hi"], { mode: "binary" });
    let out = "";
    for await (const c of p.stdout) out += new TextDecoder().decode(c);
    assert.equal(out, "ran echo hi");
    assert.equal(await p.wait(), 0);
  });
});

describe("the instance's trail over the cloud link", () => {
  const PORT3 = 18797;
  let model: Awaited<ReturnType<typeof modelStub>>;
  let link: CloudLink;
  const logged: { event: string; data: Record<string, unknown> }[] = [];
  let dialer: LinkDialer | undefined;
  before(async () => {
    model = await modelStub(() => "x");
    link = await startCloudLink({ port: PORT3, host: "127.0.0.1", token: "tok", waitMs: 3_000 });
  });
  after(async () => {
    dialer?.close();
    await link.close();
    await model.close();
  });
  const until = async (check: () => boolean, ms = 5_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("timed out");
  };

  it("holds trail lines until the server dials in, then the server logs them as vm.trail, and a line sent later goes at once", async () => {
    link.trail("lease.fence", { code: "LEASE_LAPSED", sinceMs: 7_300 }); // before anyone is connected: the VM may be dying
    link.trail("vm.health", { rssMB: 812 });
    dialer = dialLink({ url: `ws://127.0.0.1:${PORT3}/`, token: "tok", proxy: new ModelProxy({ baseUrl: model.url, model: "m", budgetTokens: 100 }), log: (event, data = {}) => logged.push({ event, data }) });
    await until(() => logged.filter((l) => l.event === "vm.trail").length === 2);
    const first = logged.find((l) => l.event === "vm.trail")!.data;
    assert.equal(first.vmEvent, "lease.fence");
    assert.deepEqual(first.data, { code: "LEASE_LAPSED", sinceMs: 7_300 }, "the instance's data is nested under its own key");
    assert.equal(typeof first.vmAt, "string");
    link.trail("lease.slow-beat", { ms: 2_400 });
    await until(() => logged.some((l) => l.event === "vm.trail" && l.data.vmEvent === "lease.slow-beat"));
  });

  it("never throws into whoever reports, whether or not a link is up", async () => {
    const lone = await startCloudLink({ port: 18798, host: "127.0.0.1", token: "tok", waitMs: 3_000 });
    try {
      for (let i = 0; i < 500; i++) lone.trail("vm.health", { i }); // past the held limit: the oldest are dropped, nothing throws
    } finally {
      await lone.close();
    }
  });
});

it("a caller's data cannot overwrite the trail line's own labels", async () => {
  // The line is logged with the event and time as the instance reported them, whatever keys its data carries.
  const logged: { event: string; data: Record<string, unknown> }[] = [];
  const link = await startCloudLink({ port: 18799, host: "127.0.0.1", token: "tok", waitMs: 3_000 });
  const model = await modelStub(() => "x");
  const dialer = dialLink({ url: "ws://127.0.0.1:18799/", token: "tok", proxy: new ModelProxy({ baseUrl: model.url, model: "m", budgetTokens: 100 }), log: (event, data = {}) => logged.push({ event, data }) });
  try {
    for (const end = Date.now() + 5_000; !logged.some((l) => l.event === "link.dialed" || l.event === "vm.trail"); await new Promise((r) => setTimeout(r, 20))) {
      link.trail("lease.fence", { vmEvent: "forged", vmAt: "forged", code: "LEASE_LAPSED" });
      if (Date.now() > end) throw new Error("timed out");
      if (logged.some((l) => l.event === "vm.trail")) break;
    }
    for (const end = Date.now() + 5_000; !logged.some((l) => l.event === "vm.trail"); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("no trail line");
    const line = logged.find((l) => l.event === "vm.trail")!.data;
    assert.equal(line.vmEvent, "lease.fence");
    assert.notEqual(line.vmAt, "forged");
    assert.deepEqual(line.data, { vmEvent: "forged", vmAt: "forged", code: "LEASE_LAPSED" });
  } finally {
    dialer.close();
    await link.close();
    await model.close();
  }
});

it("replaying held trail lines stops when the socket is backed up and keeps the rest held", () => {
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
      this.bufferedAmount += 100; // each line backs the socket up a little
    },
  };
  const held = Array.from({ length: 10 }, (_, i) => ({ t: "trail" as const, at: "t", event: `e${i}` }));
  drainTrail(socket, held, 350);
  assert.equal(sent.length, 4, "sent while the buffer was under the limit: at 0, 100, 200 and 300");
  assert.equal(held.length, 6, "the rest stays held");
  assert.equal(JSON.parse(held[0]!.event ? JSON.stringify(held[0]) : "{}").event, "e4", "in order");
  socket.bufferedAmount = 0;
  drainTrail(socket, held, 350);
  assert.equal(sent.length, 8);
});
