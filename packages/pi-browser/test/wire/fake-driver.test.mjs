// The fake driver's screenshots decode like real ones and its url() is not a read, on both faces: the core's budget
// reads dimensions from the header, so the retake ladder is observable in the dispatched rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureWithinBudget, imageSize } from "@parcha/pi-browser";
import { FakeBackend, fakeDriver, remoteDriver, remoteProvider } from "@parcha/pi-browser/testing";

const spec = { tag: "ar-run-cccc-1", maxLifetimeS: 60, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1, height: 1 }, metadata: {} };
const size = (shot) => imageSize(Buffer.from(shot.data, "base64"));

for (const face of ["in-process", "remote"]) {
  test(`${face}: screenshot headers decode, the budget retakes a full page, url() leaves no read row`, async () => {
    const backend = new FakeBackend({ deviceScale: 2, pages: {}, start: "https://example.test/start" });
    const served = await backend.serve();
    try {
      const provider = face === "remote" ? remoteProvider(served.url) : backend.provider;
      const ref = await provider.create(spec, new AbortController().signal);
      const driver = await (face === "remote" ? remoteDriver(served.url) : fakeDriver(backend))(await provider.attach(ref));

      assert.equal(await driver.url(), "https://example.test/start");
      assert.equal(backend.dispatched.filter((d) => d.op === "read").length, 0);

      assert.deepEqual(size(await driver.screenshot({ type: "png", scale: "css" })), { type: "png", width: 1288, height: 711 });
      assert.deepEqual(size(await driver.screenshot({ type: "png", fullPage: true, scale: "css" })), { type: "png", width: 1288, height: 8319 });
      assert.deepEqual(size(await driver.screenshot({ type: "png", scale: "device" })), { type: "png", width: 2576, height: 1422 });

      backend.dispatched.length = 0;
      const budgeted = await captureWithinBudget((options) => driver.screenshot(options), { fullPage: true });
      assert.equal(budgeted.adjusted?.why, "long_edge");
      assert.deepEqual(budgeted.size, { type: "jpeg", width: 1288, height: 711 });
      assert.deepEqual(backend.dispatched.map((d) => d.options), [{ fullPage: true, type: "jpeg", quality: 40 }, { fullPage: false, type: "jpeg", quality: 40, scale: "css" }]);
    } finally { await served.close(); }
  });
}
