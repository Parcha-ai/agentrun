// A form POST inside a cross-origin iframe (a payment or login widget on another origin) is seen by the observer like any other
// request: journaled when the observer only journals, held and refused when it denies. The iframe is an out-of-process target the
// observer reaches through its auto-attach; if it did not, the widget's POST would neither be journaled nor held, and a deny policy
// could not refuse it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { cdpProvider } from "../dist/providers/cdp.js";
import { cdpDriver } from "./effects/cdp-driver.mjs";
import { startServer } from "./effects/server.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const LOOPBACK = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const ROUNDS = Number(process.env.IFRAME_FORM_ROUNDS ?? 6);

test("a form POST in a cross-origin iframe is journaled under journal and held and refused under deny", { skip: NO_CHROME, timeout: 300_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create({ tag: "iframe-form", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());

  for (const mode of ["journal", "deny"]) {
    const observer = await EffectObserver.open(target, mode === "deny" ? effectDecider("deny") : null);
    for (let round = 0; round < ROUNDS; round += 1) {
      server.reset();
      // The journal as events: the latest row per request, and a promise for the row this round waits for.
      const rows = new Map();
      let arrived;
      const decided = new Promise((resolve) => { arrived = resolve; });
      const stop = observer.record((row) => { rows.set(row.requestId, row); if (row.held !== "pending") arrived(); });
      await driver.run({ code: JSON.stringify([{ goto: "/f" }, { click: "#crossform" }]) });
      await Promise.race([decided, new Promise((_, reject) => setTimeout(() => reject(new Error(`${mode}, round ${round}: the widget's form POST never reached the journal`)), 30_000).unref())]);
      await observer.flush();
      stop();
      const label = [...rows.values()].map((row) => `${row.method} ${row.path} ${row.held}`);
      if (mode === "journal") {
        assert.deepEqual(label, ["POST /api/iframe-form null"], `journal, round ${round}`);
        await server.nonGetReached(1);
        assert.deepEqual(server.nonGet(), ["POST /api/iframe-form"], "and it went out");
      } else {
        assert.deepEqual(label, ["POST /api/iframe-form denied"], `deny, round ${round}`);
        // A refused request never leaves the browser; if one did, it would reach the server within moments: a bounded wait for an
        // event that must not happen (load can make it miss a leak, never invent one).
        await assert.rejects(server.nonGetReached(1, 300), /expected non-GET/, "deny: nothing the widget posted reached the server");
        assert.deepEqual(server.nonGet(), []);
      }
      await driver.closeOthers();
    }
    observer.close();
  }
});
