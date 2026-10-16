import assert from "node:assert/strict";
import test from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startPostbackSite } from "./fixtures/postback-site.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const SPEC = { tag: "postback", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };

const idOf = (tree, label) => {
  const found = tree.match(new RegExp(`\\[(\\d+-\\d+)\\] ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(found, `the snapshot has a node "${label}"`);
  return found[1];
};
// An id click returns before the postback it set off answers: read until the page says what is expected,
// bounded, through the navigation that replaces the document; the last reading, or its error, comes back otherwise.
async function reached(driver, expected) {
  let last;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 100))) {
    let timer;
    const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(`a read still running at the ${15_000} ms deadline`), deadline - Date.now()); });
    try { last = await Promise.race([driver.run({ code: `return await page.locator('#state').textContent();` }), budget]); }
    catch (error) { last = String(error?.message ?? error); }
    finally { clearTimeout(timer); }
    if (last === expected) return last;
  }
  return last;
}

// Every postback answers 400 ms late, as on a server that takes a moment: the id click returns while the page it
// leaves is still the page.
for (const variant of [
  { name: "in view", fillerParagraphs: 0, postbackDelayMs: 400 },
  { name: "below the fold", fillerParagraphs: 40, postbackDelayMs: 400 },
  { name: "below the fold, with a fixed bar over the viewport's bottom", fillerParagraphs: 40, fixedBar: true, postbackDelayMs: 400 },
]) {
  test(`a click by snapshot id on a WebForms result link, ${variant.name}, posts the link's own __EVENTTARGET and opens its details`, { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
    const dir = await scratch(t, "pi-browser-postback-");
    const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: dir } });
    const signal = new AbortController().signal;
    const ref = await provider.create(SPEC, signal);
    t.after(() => provider.release(ref), { timeout: 30_000 });
    const site = await startPostbackSite(variant);
    t.after(() => site.close(), { timeout: 30_000 });
    let driver;
    try { driver = await stagehandDriver()(await provider.attach(ref), signal); }
    catch (error) { if (skipIncapable(t, error)) return; throw error; }
    t.after(() => driver.close().catch(() => undefined), { timeout: 30_000 });

    await driver.run({ code: `await page.goto(${JSON.stringify(site.url)}); return true;` });
    const search = await driver.snapshot();
    await driver.run({ actions: [{ op: "fill", id: idOf(search, "textbox: Entity Name"), value: "Example Financial" }, { op: "click", id: idOf(search, "button: Search") }] });
    assert.equal(await reached(driver, "search results"), "search results");

    const [first] = site.results;
    const results = await driver.snapshot();
    await driver.run({ actions: [{ op: "click", id: idOf(results, `link: ${first.name}`) }] });
    assert.equal(await reached(driver, "entity details"), "entity details");
    assert.equal(await driver.run({ code: `return await page.locator('#file').textContent();` }), first.file);
    assert.deepEqual(site.posts(), [
      { eventTarget: "", button: "Search", navigation: "" },
      { eventTarget: "rpt$ctl00$lnkbtnEntityName", button: null, navigation: "" },
    ]);
  });
}
