// A cloud host hears of the files the tab writes into the run (never delaying or failing the write): the Modal host warms the GPU
// for the creature the user drew.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

describe("the cloud host's hook on the tab's writes", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const heard: { run: string; path: string; text: string }[] = [];
  let failing = false;
  const cloud: CloudHost = {
    environments: [],
    async start() {
      return { host: "none" };
    },
    async stop() {},
    onTabWrite(ref, path, data) {
      heard.push({ run: ref.id, path, text: new TextDecoder().decode(data) });
      if (failing) throw new Error("the host broke");
    },
  };
  before(async () => {
    local = await localServer({ cloud, tabWritable: ["creature/body.json"], superviseMs: 60_000 });
  });
  after(async () => {
    await local.remove();
  });
  const put = (id: string, secret: string, tab: string, path: string, body: string) =>
    fetch(`${local.url.replace(/^ws/, "http").replace(/\/ws$/, "")}/api/runs/${id}/work/${path}`, { method: "PUT", headers: { authorization: `Bearer ${secret}`, "x-pda-tab": tab }, body });

  it("is told of a write that succeeded, with its bytes, and a failing hook does not fail the write", async () => {
    const { id, secret } = await local.server.createRun("hook");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await tab.ready;
    const ok = await put(id, secret, "a", "creature/body.json", '{"legs":4}');
    assert.equal(ok.status, 200);
    assert.deepEqual(heard, [{ run: id, path: "creature/body.json", text: '{"legs":4}' }]);
    failing = true;
    const again = await put(id, secret, "a", "creature/body.json", '{"legs":6}');
    assert.equal(again.status, 200, "the write stands although the hook threw");
    assert.equal(heard.length, 2);
    const refused = await put(id, secret, "a", "creature/other.json", "x");
    assert.equal(refused.status, 403);
    const wrongTab = await put(id, secret, "b", "creature/body.json", "x");
    assert.equal(wrongTab.status, 409);
    assert.equal(heard.length, 2, "a refused write is not announced");
    tab.close();
  });
});
