// Every page with a top bar keeps it in view: the page is as tall as the shell's main, and what is under the bar scrolls
// in a box of its own, never main itself (which would take the bar with it). Measured in a real browser at 1440x520 (wide
// and tall enough for the sidebar, not `short:`): on each page the largest box under the bar that scrolls is grown by
// 3000 px and scrolled to its end, and main must still have nothing to scroll and the bar must not move. Growing the box
// makes the check hold on a page whatever its content, so a page that only fits by chance fails too. The pages with no
// top bar (a trigger's own and new pages) scroll as one and are not here. A phone on its side
// (`short:`) scrolls the run page as a whole; narrow-layouts.mjs holds that.
// A window too small for the sidebar (a phone, upright or on its side) has no logo row for the bar to meet, and a bar whose
// actions wrap is tall there: the pages marked `whole` (the ones framed by pageClass) scroll as a whole in main, bar and
// all. Each is grown the same way and scrolled to its end: main must be what scrolled, and the bar must have left the
// screen with the page.
import { check } from "../harness.mjs";

const SIZE = { width: 1440, height: 520 };
const PHONES = [{ width: 390, height: 844 }, { width: 844, height: 390 }];
const BAR = "header, nav[aria-label=Settings], [class*='min-h-12']";

/** The page's reads answer: what is laid out under the bar is the page's, not its skeleton's. A page's skeleton (and a
 *  section's) is aria-busy until its first read answers: Mission Control's is taller than the window, so main scrolls
 *  while it shows, for longer than any fixed wait on a loaded machine. Then a moment more for a page with no skeleton. */
async function settled(page) {
  await page.waitForFunction(() => !document.querySelector("main [aria-busy=true]"));
  await page.waitForTimeout(300);
}

/** Opens `hash` fresh, waits for its bar (the one with `bar` in it, or the Settings tab `tab` current), then measures. */
async function framed(page, base, { hash, bar, tab }) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  const ready = tab ? page.locator(`main nav[aria-label=Settings] a[aria-current=page]`, { hasText: tab }) : page.locator(`main :is(${BAR})`, { hasText: bar });
  await ready.first().waitFor();
  await settled(page);
  const m = await page.evaluate((selector) => {
    const main = document.querySelector("main");
    const top = main.querySelector(selector);
    // The page's own scrolling box: the largest one under the bar that fits in main (a wide table's box inside a long
    // page also has overflow-y auto, from its overflow-x, but reaches past main).
    const edge = main.getBoundingClientRect().bottom;
    const boxes = [...main.querySelectorAll("*")].filter((el) => {
      if (top.contains(el)) return false;
      const o = getComputedStyle(el).overflowY;
      const r = el.getBoundingClientRect();
      return (o === "auto" || o === "scroll") && el.clientHeight > 0 && r.bottom <= edge + 1;
    });
    const box = boxes.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!box) return { box: null };
    const before = top.getBoundingClientRect().top;
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    box.appendChild(filler);
    box.scrollTop = box.scrollHeight;
    const seen = { box: `${box.tagName.toLowerCase()}.${String(box.className).split(" ").slice(0, 3).join(".")}`, main: main.scrollHeight - main.clientHeight, scrolled: box.scrollTop, moved: top.getBoundingClientRect().top - before };
    filler.remove();
    box.scrollTop = 0;
    return seen;
  }, BAR);
  check(m.box, `${hash}: nothing under the bar scrolls, so the page scrolls in main, bar and all`);
  check(m.main === 0, `${hash}: main scrolls the page, so the bar scrolls away: ${JSON.stringify(m)}`);
  check(m.scrolled > 0 && m.moved === 0, `${hash}: the bar moved when the page scrolled: ${JSON.stringify(m)}`);
}

/** Opens `hash` fresh in a window with no sidebar, grows its body and scrolls to the end: the page went as a whole. */
async function whole(page, base, { hash, bar }, size) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.locator(`main :is(${BAR})`, { hasText: bar }).first().waitFor();
  await settled(page);
  const m = await page.evaluate((selector) => {
    const main = document.querySelector("main");
    const top = main.querySelector(selector);
    const body = main.querySelector("[data-page-body]");
    if (!body) return { body: null };
    const before = top.getBoundingClientRect();
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    body.appendChild(filler);
    main.scrollTop = main.scrollHeight;
    body.scrollTop = body.scrollHeight;
    const after = top.getBoundingClientRect();
    // `left`: how much of the bar is still on screen under main's top edge.
    const seen = { body: getComputedStyle(body).overflowY, main: main.scrollTop, inBody: body.scrollTop, bar: Math.round(before.height), left: Math.round(after.bottom - main.getBoundingClientRect().top) };
    filler.remove();
    main.scrollTop = 0;
    body.scrollTop = 0;
    return seen;
  }, BAR);
  const at = `${hash} at ${size.width}x${size.height}`;
  check(m.body, `${at}: the page marks no body`);
  check(m.main > 0 && m.inBody === 0, `${at}: the page does not scroll as a whole, so its bar stays on a small screen: ${JSON.stringify(m)}`);
  check(m.left <= 0, `${at}: ${m.left}px of the bar is still on screen after the page scrolled: ${JSON.stringify(m)}`);
}

async function each(page, base, routes) {
  await page.setViewportSize(SIZE);
  for (const route of routes) await framed(page, base, route);
  for (const size of PHONES) {
    await page.setViewportSize(size);
    for (const route of routes) if (route.whole) await whole(page, base, route, size);
  }
}

const agent = (api, id) => api("POST", "/agents", { definition: { id, name: `Sample ${id}`, description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", tools: [] } });
async function runOf(api, id) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Invoice 17 from Northwind Freight, $240." } });
  check(started.status === 202, `starting a run answered ${started.status}`);
  return started.body.run_id;
}

const runs = {
  name: "page-frames-runs",
  signedIn: true,
  async run({ page, base, api }) {
    check((await agent(api, "sorter")).status === 201, "the agent was not made");
    const [a, b] = [await runOf(api, "sorter"), await runOf(api, "sorter")];
    await each(page, base, [
      { hash: "#/mission", bar: "Mission Control" },
      { hash: "#/runs", bar: "Runs" },
      { hash: "#/runs?archived=true", bar: "Archived runs" },
      { hash: `#/runs/${encodeURIComponent(a)}`, bar: "Sample sorter" },
      { hash: "#/races/new", bar: "New race", whole: true },
      { hash: "#/races/e2e-none", bar: "Race", whole: true },
      { hash: `#/compare?runs=${encodeURIComponent(a)},${encodeURIComponent(b)}`, bar: "Compare runs", whole: true },
    ]);
  },
};

const agents = {
  name: "page-frames-agents",
  signedIn: true,
  async run({ page, base, api }) {
    check((await agent(api, "sorter")).status === 201, "the agent was not made");
    await each(page, base, [
      { hash: "#/agents", bar: "Agents", whole: true },
      { hash: "#/agents?archived=true", bar: "Archived agents", whole: true },
      { hash: "#/agents/new?editor", bar: "New agent" },
      { hash: "#/agents/connect", bar: "Connect agent", whole: true },
      { hash: "#/agents/sorter", bar: "Sample sorter" },
      { hash: "#/agents/sorter/runs", bar: "Sample sorter" },
      { hash: "#/agents/sorter/versions", bar: "Sample sorter" },
      { hash: "#/agents/sorter/edit", bar: "Sample sorter" },
      { hash: "#/observations/e2e-unknown", bar: "Connected agent", whole: true },
      { hash: "#/dojo", bar: "Learning Dojo", whole: true },
    ]);
  },
};

const sections = {
  name: "page-frames-sections",
  signedIn: true,
  server: { args: ["--faux-github"] },
  async run({ page, base, api }) {
    check((await agent(api, "sorter")).status === 201, "the agent was not made");
    const listed = await api("GET", "/templates");
    const template = listed.body?.templates?.[0]?.name;
    check(!!template, "the server lists no template");
    const hook = await api("POST", "/triggers", { name: "e2e-hook", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "sorter", input: { content: "Sort it." }, max_cost_usd: 0.5 } });
    check(hook.status === 201, `making the trigger answered ${hook.status}`);
    await each(page, base, [
      { hash: "#/playground", bar: "API playground" },
      { hash: "#/playground?operation=create-agent", bar: "API playground" },
      { hash: "#/playground?operation=list-runs", bar: "API playground" },
      { hash: "#/playground?operation=apply-template", bar: "API playground" },
      { hash: "#/suggestions", bar: "Suggested agents", whole: true },
      { hash: "#/templates", bar: "Templates", whole: true },
      { hash: `#/templates/${encodeURIComponent(template)}`, bar: "Templates", whole: true },
      { hash: "#/triggers", bar: "Triggers", whole: true },
      { hash: "#/wrapped", bar: "Wrapped" },
    ]);
  },
};

// Settings: every page this server offers, by its tab (a server offers only the pages it supports); Demo always.
const settings = {
  name: "page-frames-settings",
  signedIn: true,
  async run({ page, base }) {
    await page.goto(`${base}/#/settings`);
    const tabs = page.locator("main nav[aria-label=Settings] a");
    await tabs.first().waitFor();
    const offered = await tabs.evaluateAll((links) => links.map((a) => ({ hash: a.getAttribute("href"), tab: (a.textContent ?? "").trim() })));
    check(offered.some((t) => t.hash === "#/settings/demo"), `Settings offers no Demo page: ${JSON.stringify(offered)}`);
    await each(page, base, offered);
  },
};

export default [runs, agents, sections, settings];
