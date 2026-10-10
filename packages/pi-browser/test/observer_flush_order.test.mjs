// flush() is the contract a cut call relies on: when it returns, every request the page started before it is in the journal.
// The page starts a request and flush() is called in the same breath (no call in between); the journal must then hold it,
// under a journaling observer and a holding one, for a fetch, an XHR, a beacon and a form submission.
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
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const label = (row) => `${row.method} ${row.path}`;
const ROUNDS = Number(process.env.FLUSH_ROUNDS ?? 10);
const ONLY = process.env.FLUSH_ONLY ?? "";


// What the page starts, by an expression the driver evaluates; the page is /c or /g (fetch, XHR and beacon targets) or /b (the form;
// its button is named "submit", which hides form.submit, hence the prototype call).
const STARTS = [
  { name: "fetch POST", page: "/c", expression: "fetch('/api/order',{method:'POST',body:'{}'}); 0", expected: "POST /api/order" },
  { name: "XHR PUT", page: "/g", expression: "(() => { const x = new XMLHttpRequest(); x.open('PUT','/api/put'); x.send('{}'); })(); 0", expected: "PUT /api/put" },
  { name: "beacon", page: "/g", expression: "navigator.sendBeacon('/api/beacon','{}'); 0", expected: "POST /api/beacon" },
  { name: "form submit", page: "/b", expression: "HTMLFormElement.prototype.submit.call(document.querySelector('form')); 0", expected: "POST /submit" },
];

test("flush returns only once a request the page has just started is in the journal, journaling and holding alike", { skip: NO_CHROME, timeout: 600_000 }, async (t) => {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); });
  ref = await provider.create(spec("flush-order"), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close());

  const misses = [];
  for (const mode of ["journal", "deny"]) {
    const observer = await EffectObserver.open(target, mode === "deny" ? effectDecider("deny") : null);
    for (const start of STARTS) {
      for (let round = 0; round < ROUNDS; round += 1) {
        await driver.run({ code: JSON.stringify([{ goto: start.page }]) });
        const rows = new Map();
        const stop = observer.record((row) => { rows.set(row.requestId, row); });
        await driver.fire(start.expression);
        await observer.flush();
        const journaled = [...rows.values()].map(label);
        stop();
        if (!journaled.includes(start.expected)) misses.push(`${mode} ${start.name} (round ${round})`);
        // Let the page's request finish before the next round, so a late row cannot land in the next one.
        if (mode === "journal") await server.nonGetReached(1, 15_000).catch(() => undefined);
        server.reset();
        await driver.closeOthers();
      }
    }
    observer.close();
  }
  const by = {};
  for (const m of misses) { const k = m.replace(/ \(round \d+\)/, ""); by[k] = (by[k] ?? 0) + 1; }
  assert.deepEqual(by, {}, `the journal missed a request that had been started before flush returned, of ${ROUNDS} rounds each`);
});
