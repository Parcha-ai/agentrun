import assert from "node:assert/strict";
import test from "node:test";
import { browserbaseProvider } from "../dist/providers/browserbase.js";
import { connectDialUrl } from "../dist/providers/browserbase-net.js";
import { kernelProvider } from "../dist/providers/kernel.js";
import { browserbaseHoldings, kernelHoldings, resetProviderHoldings } from "../dist/providers/shared.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";
import { fakeKernel } from "./fixtures/fake-kernel.mjs";

const signal = () => new AbortController().signal;
const spec = (tag) => ({ tag, maxLifetimeS: 1800, idleTimeoutS: 180, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: { run: "run 1" } });

test("a provider built later releases what an earlier one attached, and the reset empties every holding", async (t) => {
  const fake = fakeBrowserbase();
  const env = { BROWSERBASE_API_KEY: `not-a-secret-holdings-${process.pid}`, BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: "wss://proxy.example/ws" };
  const sockets = [];
  const make = () => browserbaseProvider({ env, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => { const s = { open: true, close() { this.open = false; } }; sockets.push(s); return s; } });
  const ref = await make().create(spec("ar-hold-1-1"), signal());
  const url = (await make().attach(ref)).sdkCdpUrl;
  assert.equal(browserbaseHoldings.connectUrls.size, 1);
  assert.equal(browserbaseHoldings.settings.size, 1);
  assert.equal(browserbaseHoldings.uploads.size, 1);
  assert.notEqual(connectDialUrl(url), url);

  await make().release(ref);
  assert.equal(sockets[0].open, false);
  assert.equal(browserbaseHoldings.connectUrls.size, 0);
  assert.equal(connectDialUrl(url), url);

  const second = await make().create(spec("ar-hold-2-1"), signal());
  await make().attach(second);
  assert.ok(browserbaseHoldings.connectUrls.size + browserbaseHoldings.settings.size + browserbaseHoldings.boundDials.size > 0);
  resetProviderHoldings();
  for (const holdings of [browserbaseHoldings, kernelHoldings]) for (const [name, map] of Object.entries(holdings)) assert.equal(map.size, 0, name);
});

test("the Kernel provider's holdings are process-wide: a fresh provider finds the CDP URL the first one created", async (t) => {
  const key = `kernel-holdings-${process.pid}`;
  const kernel = await fakeKernel({ key, sentinels: {}, knobs: {} });
  t.after(() => kernel.close());
  const env = { KERNEL_API_KEY: key, KERNEL_BASE_URL: kernel.url };
  const make = () => kernelProvider({ env, sleep: async () => {}, confirm: { polls: 3, intervalMs: 0 } });
  const ref = await make().create(spec("ar-hold-3-1"), signal());
  assert.equal(kernelHoldings.cdpUrls.size, 1);
  const before = kernel.calls.length;
  await make().attach(ref);
  assert.equal(kernel.calls.length, before, "attach reads the held URL and asks Kernel nothing");
  await make().release(ref);
  assert.equal(kernelHoldings.cdpUrls.size, 0);
});
