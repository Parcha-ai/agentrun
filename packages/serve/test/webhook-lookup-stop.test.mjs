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
import { setTimeout as sleep } from "node:timers/promises";
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
  // The save's check resolves it to a public address; the try's lookup starts as the server stops, and its NXDOMAIN
  // comes after.
  const lookup = async (host) => {
    asked.push(host);
    if (asked.length === 1) return ["93.184.216.34"];
    void webhooks.close();
    await sleep(20);
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
  };
  webhooks = new Webhooks(store, randomBytes(32), () => undefined, { retryMs: [], lookup });
  await webhooks.load();
  await webhooks.save({ url: "https://hooks.example/in" });
  const tried = await webhooks.test();
  assert.equal(tried.error, "not reached: the server is stopping");
  await sleep(100);
  assert.deepEqual(asked, ["hooks.example", "hooks.example"]);
  assert.deepEqual(unhandled.map(String), [], "the lookup's failure after the stop is handled");
});
