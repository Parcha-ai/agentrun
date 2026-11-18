// The run page's Dev tools tab with a call's panel open, measured in a real browser (jsdom lays nothing out and has no
// container queries). Beside the panel the table has what the panel leaves of the page: at a window 1538 px wide that
// is 740 px, and the table with its time axis and its Size column needs some 900. Both showed there from 1536 px of
// window on, so the pane scrolled sideways until the window was some 1700 px wide. They show by the pane's width instead:
//  - from 1280 px on (the panel beside the table) nothing in the tab scrolls sideways and the table is no wider than its
//    box, at the widths the defect was measured at (1538, 1600) and around them;
//  - on a wide window the table has its axis and its Size column back;
//  - at 1024 px (the panel under the table) the table scrolls in its own box and the pane does not scroll sideways.
// The trace is this flow's own (routed), in the served shape: the faux model answers in milliseconds, calls no tool and
// never caches, so a recorded trace has neither the columns' usual words nor a row worth opening.
import { check } from "../harness.mjs";

const START = Date.parse("2026-11-17T21:14:02.000Z");
const iso = (ms) => new Date(START + ms).toISOString();
const BLANK = { parent_id: null, agent_label: null, stop_reason: null, tokens: null, usd: null, decision: false, charged: false, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null };
const request = (n, from, to, [input, cache_read, cache_write, output], usd) =>
  ({ ...BLANK, id: `m:0:${n}`, kind: "model", name: "claude-sonnet-5-5", started_at: iso(from), ended_at: iso(to), status: "ok", stop_reason: "toolUse", tokens: { input, cache_read, cache_write, output }, usd });
const call = (id, by, name, from, to, input, size, more = {}) =>
  ({ ...BLANK, id: `t:0:${id}`, kind: "tool", parent_id: `m:0:${by}`, name, started_at: iso(from), ended_at: iso(to), status: "ok", tool_use_id: id, input_preview: input, result_preview: "ok", result_size_bytes: size, ...more });
const trace = (runId) => ({
  run_id: runId, model_requests: "priced", dropped: 0,
  spans: [
    request(1, 3_400, 8_200, [1_204, 0, 18_420, 412], 0.078867),
    call("c1", 1, "web_search", 8_500, 12_800, '{"query":"Northwind Freight Ltd company registration","n":6}', 8_612, { usd: 0.005, charged: true }),
    call("c2", 1, "web_fetch", 8_600, 14_100, '{"url":"https://tradepress.example/2026/northwind-freight-audit"}', 366, { status: "failed" }),
    request(2, 14_900, 21_100, [2, 58_058, 14_502, 1_105], 0.088382),
    call("c3", 2, "mcp:crm/lookup_account", 21_300, 22_600, '{"name":"Northwind Freight Ltd"}', 212, { not_metered: true }),
    call("c4", 2, "bash", 21_400, 60_000, '{"command":"python extract_filings.py --company NF-204418"}', 51_600),
    request(3, 60_200, 118_500, [2, 83_800, 1_912, 6_840], 0.134916),
  ],
});

/** What the tab's layout is at this window width. */
const measure = () => {
  const pane = document.querySelector("[data-scroll-pane]");
  const table = pane.querySelector("section[aria-label='Trace'] > div > table");
  const box = table.parentElement;
  const shown = (el) => !!el && getComputedStyle(el).display !== "none";
  const said = (e) => `${e.getAttribute("aria-label") ?? e.tagName.toLowerCase()} ${e.scrollWidth} in ${e.clientWidth}`;
  return {
    beside: getComputedStyle(pane).display === "flex",
    // Every box of the tab that scrolls sideways: it holds more than it shows.
    sideways: [pane, ...pane.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(e).overflowX)).map((e) => (e === box ? "table" : e === pane ? "pane" : said(e))),
    table: Math.round(table.getBoundingClientRect().width), box: box.clientWidth,
    page: document.documentElement.scrollWidth - innerWidth,
    axis: shown(table.querySelector("th[data-axis]")),
    size: shown([...table.querySelectorAll("thead th")].find((th) => th.textContent.trim() === "Size")),
  };
};

export default {
  name: "dev-tools-panel-width",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: "screener", name: "Screener", instructions: "Answer the question.", skills: [], tools: [] } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    const started = await api("POST", "/agents/screener/runs", { input: { content: "Screen Northwind Freight Ltd." } });
    check(started.status === 202, `starting the run answered ${started.status}: ${JSON.stringify(started.body)}`);
    const runId = started.body.run_id;
    await page.route(`**/v2/runs/${encodeURIComponent(runId)}/trace`, (route) => route.fulfill({ json: trace(runId) }));

    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
    await page.getByRole("heading", { level: 1 }).locator("xpath=..").getByText("Completed", { exact: true }).waitFor({ timeout: 45_000 });
    await page.getByRole("tab", { name: "Dev tools", exact: true }).click();
    const rows = page.locator("section[aria-label='Trace'] > div > table > tbody > tr");
    await rows.first().waitFor();
    check((await rows.count()) === 7, `the table lists ${await rows.count()} of the trace's 7 spans`);
    // The second request's panel: the one whose row has the table's longest figures.
    await rows.nth(3).getByRole("button").click();
    await page.locator("aside[aria-label='Call details']").waitFor();

    // The panel beside the table: nothing scrolls sideways and the table fits its box, at every width.
    for (const width of [1280, 1400, 1535, 1536, 1538, 1600, 1650, 1707, 1800, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const m = await page.evaluate(measure);
      check(m.beside, `${width}: the panel is not beside the table`);
      check(m.sideways.length === 0, `${width}: scrolls sideways with a call's panel open: ${m.sideways.join(", ")}`);
      check(m.table <= m.box + 1, `${width}: the table is ${m.table} px wide in a box of ${m.box}`);
      check(m.page <= 0, `${width}: the page is ${m.page} px wider than the window`);
    }
    // A wide window has room for every column beside the panel: the axis and Size are back.
    const wide = await page.evaluate(measure);
    check(wide.axis && wide.size, `1920: beside the panel the table shows ${wide.axis ? "its" : "no"} time axis and ${wide.size ? "its" : "no"} Size column`);
    // With the panel closed the table has the page's width, and both show where there was no room beside the panel.
    await page.setViewportSize({ width: 1538, height: 900 });
    const beside = await page.evaluate(measure);
    check(!beside.axis && !beside.size, `1538: the table's ${beside.box} px beside the panel hold ${beside.axis ? "the time axis" : ""} ${beside.size ? "the Size column" : ""}`);
    await page.getByRole("button", { name: "Close call details", exact: true }).click();
    await page.locator("aside[aria-label='Call details']").waitFor({ state: "detached" });
    const alone = await page.evaluate(measure);
    check(alone.axis && alone.size, `1538, no panel: the table shows ${alone.axis ? "its" : "no"} time axis and ${alone.size ? "its" : "no"} Size column`);
    check(alone.sideways.length === 0 && alone.table <= alone.box + 1, `1538, no panel: ${alone.sideways.join(", ")}; the table is ${alone.table} px in ${alone.box}`);

    // The panel under the table: a table wider than its box scrolls there, and the pane does not scroll sideways with it.
    await rows.nth(3).getByRole("button").click();
    await page.locator("aside[aria-label='Call details']").waitFor();
    await page.setViewportSize({ width: 1024, height: 900 });
    const under = await page.evaluate(measure);
    check(!under.beside, "1024: the panel is beside the table");
    check(under.table > under.box, `1024: the table (${under.table} px) fits its box (${under.box}), so this says nothing of a table that scrolls`);
    check(under.sideways.join() === "table", `1024: what scrolls sideways is ${under.sideways.join(", ") || "nothing"}, not the table alone`);
    check(under.page <= 0, `1024: the page is ${under.page} px wider than the window`);
  },
};
