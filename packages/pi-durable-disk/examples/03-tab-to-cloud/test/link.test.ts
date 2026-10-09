// A cloud host's link: the host listens, the server dials in with a bearer token, and the host's model calls reach the
// model endpoint through the server's ModelProxy (its budget counts them). A wrong token is refused.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startCloudLink, type CloudLink } from "../cloud-link.ts";
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
