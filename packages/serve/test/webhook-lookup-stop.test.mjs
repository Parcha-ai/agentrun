// The outbound webhook's lookup of its receiver's name (webhooks.ts dialled) when the server stops: a try that starts
// as the server stops gives up at once, in words, and the lookup it had started is never left to fail on its own. A CI
// runner whose resolver answered NXDOMAIN for a test's hooks.example after the stop raised it as an unhandled
// rejection, which failed whichever test was running.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { Webhooks } from "../dist/webhooks.js";

test("a try whose name lookup starts as the server stops is given up on in words, and the lookup's late NXDOMAIN is no unhandled rejection", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "webhook-stop-"));
  const store = await openSqliteStore({ dataDir: dir });
  t.after(async () => (await store.close(), rmSync(dir, { recursive: true, force: true })));
  const unhandled = [];
  const seen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", seen);
  t.after(() => process.off("unhandledRejection", seen));
  const asked = [];
  let webhooks;
  let nxdomain;
  // The save's check resolves the name to a public address. The try's lookup is where the stop lands: the server stops
  // as it is asked, and its answer, NXDOMAIN, comes only once the test says, after the try has given up.
  const lookup = (host) => {
    asked.push(host);
    if (asked.length === 1) return Promise.resolve(["93.184.216.34"]);
    void webhooks.close();
    return new Promise((_, reject) => (nxdomain = () => reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host }))));
  };
  webhooks = new Webhooks(store, randomBytes(32), () => undefined, { retryMs: [], lookup });
  await webhooks.load();
  await webhooks.save({ url: "https://hooks.example/in" });
  const tried = await webhooks.test();
  assert.deepEqual(asked, ["hooks.example", "hooks.example"]);
  assert.equal(tried.error, "not reached: the server is stopping");
  nxdomain();
  // A rejection no one handles is told once the microtasks run out: a turn of the event loop after the answer.
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(unhandled.map(String), [], "the lookup's failure after the stop is handled");
});
