// The wire check on the package: every secret the design names is planted in a fake provider, a fake driver and a
// fake broker, which echo them back on failure the way vendor SDKs do; every failure the package can make of them is
// scanned for the sentinels. Red on a planted leak (scanner.test.mjs), green here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, WEB_TOOLS, browserSection, classifyBrowserError, createRedactor, redactDeep } from "@parcha/pi-browser";
import { FakeBackend, fakeDriver, sentinelPages } from "@parcha/pi-browser/testing";
import { kernelProvider } from "@parcha/pi-browser/providers/kernel";
import { fakeKernel } from "../fixtures/fake-kernel.mjs";
import { Scan } from "./scan.mjs";
import { ALLOW, hostRegistered, makeSentinels } from "./sentinels.mjs";

const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 180, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 800 }, metadata: { agentrun_tag: tag } });
const signal = () => new AbortController().signal;

/** Every provider and driver op that can fail, called on a backend that echoes its secrets. */
async function failures(b) {
  const driver = fakeDriver(b);
  const ref = await b.provider.create(spec("ar-wire-1"), signal());
  const target = await b.provider.attach(ref, signal());
  const attached = await driver(target);
  const ops = {
    create: () => b.provider.create(spec("ar-wire-2"), signal()),
    findByTag: () => b.provider.findByTag("ar-wire-1", signal()),
    status: () => b.provider.status(ref, signal()),
    attach: () => b.provider.attach(ref, signal()),
    release: () => b.provider.release(ref, signal()),
    fetch: () => b.provider.fetch({ url: "https://example.test/article", format: "markdown", proxies: false }, signal()),
    search: () => b.provider.search({ query: "q", n: 3 }, signal()),
    "driver.connect": () => driver(target),
    "driver.snapshot": () => attached.snapshot(),
    "driver.run": () => attached.run({ code: "return 1" }),
  };
  const out = [];
  for (const [op, run] of Object.entries(ops)) {
    b.fail(op, 1);
    try { await run(); out.push({ op, error: null }); } catch (error) { out.push({ op, error }); }
  }
  return out;
}

test("every failure of the provider, driver and broker, echoing every secret, reaches the model redacted", async () => {
  const sentinels = makeSentinels();
  const b = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), fetches: { "https://example.test/article": "x" } });
  b.echo(true);
  const redact = createRedactor(() => hostRegistered(sentinels));
  const results = await failures(b);
  assert.ok(results.every((r) => r.error), `an op did not fail: ${results.filter((r) => !r.error).map((r) => r.op)}`);

  const raw = new Scan(sentinels, { allow: ALLOW });
  const seen = new Scan(sentinels, { allow: ALLOW });
  for (const { op, error } of results) {
    for (const effectful of [false, true]) {
      const failure = classifyBrowserError(error, effectful);
      raw.json("unredacted", failure, `${op}`);
      seen.json("tool-result", redactDeep(failure, redact), `${op}`);
    }
  }
  assert.ok(!raw.clean(), "the fake's echo carries no sentinel: the check would prove nothing");
  assert.equal(seen.report(), "no sentinel found");
  assert.ok(seen.coverageOf("tool-result").records >= results.length * 2);
});

test("the static model surface carries no sentinel", () => {
  const sentinels = makeSentinels();
  const scan = new Scan(sentinels, { allow: ALLOW });
  scan.json("contract", [...BROWSER_TOOLS, ...WEB_TOOLS]);
  scan.text("section", "browser", browserSection({ idleReleaseS: 180 }));
  assert.equal(scan.report(), "no sentinel found");
  assert.ok(scan.coverageOf("contract").records === 1);
});

test("every failure of the kernel provider, against a Kernel that echoes every secret, carries none of them even unredacted", async (t) => {
  const sentinels = makeSentinels();
  const api = await fakeKernel({ key: sentinels.kernelApiKey, sentinels, knobs: { echo: true } });
  t.after(() => api.close());
  const env = { KERNEL_API_KEY: sentinels.kernelApiKey, KERNEL_BASE_URL: api.url };
  const provider = kernelProvider({ env, sleep: async () => {}, confirm: { polls: 1, intervalMs: 0 } });
  const ref = await provider.create(spec("ar-wire-k1"), signal());
  // A key Kernel refuses (401) for the reads; a server error for the create and every delete, with the delete never showing.
  const refused = kernelProvider({ env: { ...env, KERNEL_API_KEY: `${sentinels.kernelApiKey}-refused` }, extension: async () => ({ name: "ext" }) });
  Object.assign(api.knobs, { createStatus: 500, deleteStatuses: [500, 500], deleteLag: 99 });
  const ops = {
    create: () => provider.create(spec("ar-wire-k2"), signal()),
    findByTag: () => refused.findByTag("ar-wire-k1", signal()),
    status: () => refused.status(ref, signal()),
    attach: () => refused.attach({ id: "kb_elsewhere", tag: "ar-wire-k3" }, signal()),
    release: () => provider.release(ref, signal()),
  };
  const raw = new Scan(sentinels, { allow: ALLOW });
  for (const [op, run] of Object.entries(ops)) {
    const error = await run().then(() => null, (e) => e);
    assert.ok(error, `${op} did not fail`);
    raw.text("unredacted", `${op}.stack`, String(error.stack));
    for (const effectful of [false, true]) raw.json("unredacted", classifyBrowserError(error, effectful), op);
  }
  assert.equal(raw.report(), "no sentinel found", "the provider copies no Kernel text, so nothing needs the redactor");
  // The echo is real: the same refused call, read by hand, carries the key and the CDP token.
  const echoed = new Scan(sentinels, { allow: ALLOW });
  echoed.text("kernel-body", "GET /browsers", await (await fetch(`${api.url}/browsers`, { headers: { Authorization: "Bearer refused" } })).text());
  assert.ok(!echoed.clean(), "the fake's echo carries no sentinel: the check would prove nothing");
});

// Broker failures echo login values, a TOTP seed and a vault reference the package never holds, so the defense is
// structural (the brokered provider maps broker errors to codes and drops their text). It is scanned here once that
// provider exists.
test("every failure of the broker reaches the model as a code, never as the broker's text", { skip: "needs the brokered provider" }, () => {});
