// A tab taking the run offline stalls its own main thread for seconds (saving the workspace, copying the store), longer than the writer grace on a loaded machine, and the server declared it gone
// in the middle of the checkout ("no ping from the tab"). A tab now says `checkout-begin` first: the pipe holds it, to a bound, until `checkout-done`; past the bound it is an ordinary silent writer.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

const GRACE_MS = 300;
const BOUND_MS = 1_500;

describe("a writer taking the run offline", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown>; at: number }[] = [];
  before(async () => {
    local = await localServer({ writerGraceMs: GRACE_MS, checkoutGraceMs: BOUND_MS, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data, at: Date.now() }) });
  });
  after(async () => {
    await local.remove();
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const gone = (id: string) => events.find((e) => e.event === "pipe.writer-gone" && e.data.run === id);
  const goneWithin = async (id: string, ms: number) => {
    for (const end = Date.now() + ms; !gone(id); await sleep(25)) if (Date.now() > end) return undefined;
    return gone(id);
  };
  /** A writer whose tab sends no ping of its own (a stalled main thread): only the frames a test sends reach the pipe. */
  const attach = async (name: string) => {
    const { id, secret } = await local.server.createRun(name);
    const tab = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 600_000, onFrame: () => undefined });
    await tab.ready;
    tab.send({ t: "writer-ready" });
    return { id, tab };
  };

  it("is declared gone after the grace when it says nothing (the control)", async () => {
    const { id, tab } = await attach("silent");
    const at = Date.now();
    const found = await goneWithin(id, 3_000);
    assert.ok(found, "a silent writer is retired");
    assert.ok(found.at - at < BOUND_MS, `after about the grace, not the checkout bound (${found.at - at} ms)`);
    tab.close();
  });

  it("is held while its checkout runs: silent for three times the grace, it is still the writer, and it is declared gone only at the bound", async () => {
    const { id, tab } = await attach("held");
    const begun = Date.now();
    tab.send({ t: "checkout-begin" });
    await sleep(GRACE_MS * 3);
    assert.equal(gone(id), undefined, `not retired inside the bound (after ${Date.now() - begun} ms)`);
    const found = await goneWithin(id, BOUND_MS * 3);
    assert.ok(found, "a tab that died mid-checkout is never held for ever");
    assert.ok(found.at - begun >= BOUND_MS - 100, `retired at the bound, not before it (${found.at - begun} ms)`);
    tab.close();
  });

  it("goes back to the normal grace when the checkout ends without a handover", async () => {
    const { id, tab } = await attach("done");
    const begun = Date.now();
    tab.send({ t: "checkout-begin" });
    await sleep(200);
    tab.send({ t: "checkout-done" });
    const found = await goneWithin(id, BOUND_MS * 2);
    assert.ok(found, "a silent writer is retired once the checkout is over");
    assert.ok(found.at - begun < BOUND_MS, `by the grace, not the bound (${found.at - begun} ms)`);
    tab.close();
  });

  it("is not held when its socket closes mid-checkout", async () => {
    const { id, tab } = await attach("closed");
    const begun = Date.now();
    tab.send({ t: "checkout-begin" });
    await sleep(100);
    tab.close();
    const found = await goneWithin(id, BOUND_MS * 2);
    assert.ok(found, "a closed socket is retired");
    assert.ok(found.at - begun < BOUND_MS, `without waiting for the bound (${found.at - begun} ms)`);
  });

  it("stays the writer past the bound while it still sends frames", async () => {
    const { id, tab } = await attach("alive");
    tab.send({ t: "checkout-begin" });
    const end = Date.now() + BOUND_MS + 900;
    while (Date.now() < end) {
      tab.send({ t: "ping", at: 0 });
      await sleep(100);
    }
    assert.equal(gone(id), undefined);
    tab.close();
  });
});
