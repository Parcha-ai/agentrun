import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { RunTrace } from "@/components/RunTrace";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_LIVE, TRACE_LIVE_NOW, TRACE_START, TRACE_USD, USAGE_CLI, USAGE_MACHINES, USAGE_REDO } from "@/components/RunTrace.sample";
import { messageFeatures } from "@/fixtures";
import type { Run, RunTrace as Trace, RunUsage } from "@/lib/v2";

// The run page's Dev tools tab: every model request and tool call of the run in one table and on one time axis, each
// opening to what it used and cost, and the run's totals by tool and by model. Read from GET /v2/runs/{id}/trace.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const RUN: Run = { sha: null, updated_at: new Date(TRACE_END).toISOString(), poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run_7f3a9c2e", agent_id: "supplier-screening", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Screen Northwind Freight Ltd",
  created_at: new Date(TRACE_START).toISOString(), ended_at: new Date(TRACE_END).toISOString(), result: null, error: null, cost: { usd: TRACE_USD, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
};

async function open(trace: Trace | (() => Promise<Trace>), props: Partial<React.ComponentProps<typeof RunTrace>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const read = typeof trace === "function" ? trace : async () => trace;
  act(() => root!.render(createElement(RunTrace, { run: RUN, read, version: "1", live: false, now: TRACE_END, ...props })));
  await settle();
  return host;
}
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const rows = (host: Element) => [...host.querySelectorAll("tbody tr")].filter((tr) => tr.closest("section[aria-label='Trace'] > div > table"));
const callRows = (host: Element) => [...host.querySelectorAll("section[aria-label='Trace'] > div > table > tbody > tr")];
const rowOf = (host: Element, text: string) => callRows(host).find((tr) => tr.textContent?.includes(text));
const panel = (host: Element) => host.querySelector("aside[aria-label='Call details']");
const tile = (host: Element, label: string) => [...host.querySelectorAll("dl[aria-label='The run in figures'] dt")].find((dt) => dt.textContent === label)?.parentElement;
const overviewOf = (host: Element) => host.querySelector("section[aria-label='Overview of the run']")!;
const zoomSaid = (host: Element) => host.querySelector("[role=group][aria-label=\"Zoom the table's time axis\"] [role=status]")!.textContent;
const named = (host: Element, name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label='${name}']`)!;
const pick = async (host: Element, name: string, value: string) => click(host.querySelector(`input[name="${name}"][value="${value}"]`));
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};

describe("the Dev tools tab", () => {
  it("says what the run added up to: its requests, calls, failures, tokens, cost and time", async () => {
    const host = await open(TRACE);
    expect(tile(host, "Model requests")?.textContent).toContain("8");
    expect(tile(host, "Model requests")?.textContent).toContain("claude-sonnet-5-5");
    expect(tile(host, "Tool calls")?.textContent).toMatch(/16.*8 tools/);
    expect(tile(host, "Failed")?.textContent).toMatch(/1.*First: web_fetch/);
    expect(tile(host, "Tokens")?.textContent).toMatch(/498K.*81% of input read from cache/);
    // The run's own cost, with what the trace knows of it: the requests' and the charges under the calls.
    expect(tile(host, "Cost, estimated")?.textContent).toMatch(/\$0\.6336.*requests \$0\.6132 · tools \$0\.0204/);
    expect(tile(host, "Time")?.textContent).toMatch(/3m 45s.*model 38% · tools 60%/);
  });

  it("says how much of its spend cap the run's cost is, and that it stopped short for it", async () => {
    // $0.6336 of a $0.75 cap.
    const run = { ...RUN, cost: { ...RUN.cost!, cap_usd: 0.75 }, stopped_for: "budget" as const, budget_refused_calls: 3 };
    const host = await open(TRACE, { run, view: "breakdown" });
    expect(tile(host, "Cost, estimated")?.textContent).toMatch(/\$0\.6336.*84% of its \$0\.75 cap · requests \$0\.6132 · tools \$0\.0204/);
    expect([...host.querySelectorAll("section[aria-label='What stands out'] li")][0]!.textContent).toBe("The run stopped short for its budgetIts model was told to answer soon, to stay under its $0.75 cap, and it answered from what it had. 3 tool calls were refused, unrun, for its budget.");
    // A cost that is a ceiling is at most that share of the cap, never an exact one.
    const held = await open(TRACE, { run: { ...RUN, cost: { ...RUN.cost!, cap_usd: 0.75, upper_bound: true } } });
    expect(tile(held, "Cost, estimated")?.textContent ?? tile(held, "Cost")?.textContent).toMatch(/at most 84% of its \$0\.75 cap/);
    // A run with no cap says none, and one that never came near its cap says nothing of a stop.
    const plain = await open(TRACE, { run: { ...RUN, cost: { ...RUN.cost!, cap_usd: 5 } }, view: "breakdown" });
    expect(tile(plain, "Cost, estimated")?.textContent).toMatch(/13% of its \$5\.00 cap/);
    expect(plain.textContent).not.toMatch(/stopped short|told to wrap up|refused for the run/);
  });
  it("says a run was told to wrap up for its budget though its trace has no request and no call", async () => {
    // A CLI harness's record keeps no request, and the run answered its wrap-up without calling a tool.
    const run = { ...RUN, cost: { ...RUN.cost!, cap_usd: 0.75 }, stopped_for: "budget" as const, budget_refused_calls: 0 };
    const host = await open({ run_id: RUN.run_id, model_requests: "not_recorded", spans: [], dropped: 0 }, { run });
    expect([...host.querySelectorAll("section[aria-label='What stands out'] li")].map((li) => li.textContent)).toEqual(["The run was told to wrap up for its budgetIts model was told to answer soon, to stay under its $0.75 cap. No tool call was refused."]);
    // Told to wrap up and no more: said plainly. With a call refused the run did less than it was asked, and it reads as bad.
    const red = (h: Element) => h.querySelector("section[aria-label='What stands out'] li span")!.className.includes("text-destructive-text");
    const refused = await open({ run_id: RUN.run_id, model_requests: "not_recorded", spans: [], dropped: 0 }, { run: { ...run, budget_refused_calls: 2 } });
    expect([red(host), red(refused)]).toEqual([false, true]);
    // A run with no span that did not stop for its budget has no such section.
    const plain = await open({ run_id: RUN.run_id, model_requests: "not_recorded", spans: [], dropped: 0 });
    expect(plain.querySelector("section[aria-label='What stands out']")).toBeNull();
  });
  it("lists every request and call in the order they started, each call under the request that made it", async () => {
    const host = await open(TRACE);
    const listed = callRows(host);
    expect(listed).toHaveLength(24);
    expect(listed[0]!.textContent).toMatch(/Model.*claude-sonnet-5-5.*\+0:00\.0.*4\.8 s.*19\.6K in · 412 out.*\$0\.0789.*OK/);
    expect(listed[1]!.textContent).toMatch(/Tool.*skill.*supplier-screening.*4 ms.*4\.1 KB.*–.*OK/);
    expect(listed[1]!.querySelector("button")!.className).toContain("pl-4");
    expect(rowOf(host, "tradepress.example/2026/northwind-freight-audit\"}")!.textContent).toContain("Failed");
    expect(rowOf(host, "lookup_account")!.textContent).toContain("Not metered");
  });

  it("draws the whole run in an overview, a lane for requests and one for calls; a bar opens its span", async () => {
    const host = await open(TRACE);
    const overview = overviewOf(host);
    expect([...overview.querySelectorAll("p.caps")].map((p) => p.textContent)).toEqual(["Model requests (8)", "Tool calls (16)"]);
    // The overview is a picture: a screen reader gets one sentence for it, and the keyboard no stop in it.
    expect(overview.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("The run on a time axis: 8 model requests and 16 tool calls over 3m 45s. The table lists each.");
    expect(overview.querySelectorAll("[role=img] button, [role=img] [tabindex]")).toHaveLength(0);
    const bar = overview.querySelector<HTMLElement>("[data-span='t:0:call_10']")!;
    expect(bar.style.left).toBe(`${((54_200 - 3400) / 224_500) * 100}%`);
    await click(bar);
    expect(panel(host)!.textContent).toContain("python extract_filings.py");
    expect(bar.hasAttribute("data-open")).toBe(true);
    // Every bar and swatch is a mark with an edge that shows under forced colours, where a fill alone is not drawn.
    expect([...overview.querySelectorAll("[data-span], li > span[aria-hidden], p.caps > span[aria-hidden]")].every((mark) => mark.classList.contains("trace-mark"))).toBe(true);
    // Its row is now the table's stop for the keyboard.
    expect(rowOf(host, "extract_filings")!.querySelector("button")!.tabIndex).toBe(0);
  });

  it("puts each row's bar on the table's own time axis, under marks that name the time", async () => {
    const host = await open(TRACE);
    const head = host.querySelector("section[aria-label='Trace'] > div > table > thead th[data-axis]")!;
    expect(head.querySelector(".sr-only")!.textContent).toBe("On the time axis");
    expect([...head.querySelectorAll("[aria-hidden] > span")].map((mark) => mark.textContent)).toEqual(["0:00", "1:00", "2:00", "3:00"]);
    const bar = rowOf(host, "extract_filings")!.querySelector<HTMLElement>("[data-bar]")!;
    expect(Number.parseFloat(bar.style.left)).toBeCloseTo(((54_200 - 3400) / 224_500) * 100, 6);
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo((38_600 / 224_500) * 100, 6);
    // The bar draws what the Started and Duration cells say in figures: a screen reader reads those.
    expect(bar.closest("td")!.getAttribute("aria-hidden")).toBe("true");
    // A call that failed is striped as well as red: told by more than its colour.
    expect(rowOf(host, "northwind-freight-audit\"}")!.querySelector("[data-bar]")!.className).toContain("trace-hatch");
  });

  it("zooms the table's time axis: the overview frames the part that shows, and the table lists what ran in it", async () => {
    const host = await open(TRACE);
    expect(named(host, "Zoom out").disabled).toBe(true);
    expect(zoomSaid(host)).toBe("");
    expect(named(host, "Earlier")).toBeNull();
    await click(named(host, "Zoom in"));
    // Half the run shows, about its middle: from a quarter of the way in (56.1 s of 3m 45s) to three quarters.
    expect(zoomSaid(host)).toBe("+0:56.1 to +2:48.3");
    const band = overviewOf(host).querySelector<HTMLElement>("[data-band]")!;
    expect([band.style.left, band.style.width]).toEqual(["25%", "50%"]);
    // What ran between 59.5 s and 171.8 s after the run's start: the long shell command, two requests, the four calls
    // of the first, the request after them, the mail call and the request that wrote the report.
    expect(callRows(host)).toHaveLength(9);
    expect(callRows(host)[0]!.textContent).toContain("extract_filings");
    expect(host.querySelector("[role=status]")!.textContent).toBe("9 of 24 shown");
    expect([...host.querySelectorAll("section[aria-label='Trace'] > div > table > thead th[data-axis] [aria-hidden] > span")].map((mark) => mark.textContent)).toEqual(["1:00", "1:30", "2:00", "2:30"]);
    await click(named(host, "Later"));
    expect(zoomSaid(host)).toBe("+1:52.2 to +3:44.5");
    expect(named(host, "Later").disabled).toBe(true);
    await click(named(host, "Fit the whole run"));
    expect(zoomSaid(host)).toBe("");
    expect(callRows(host)).toHaveLength(24);
  });

  it("a drag across the overview picks the part of the run the table shows; a press that does not move opens a bar", async () => {
    const host = await open(TRACE);
    const overview = host.querySelector<HTMLElement>("[data-overview]")!;
    overview.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, height: 60, right: 1100, bottom: 60, x: 100, y: 0, toJSON: () => ({}) });
    const point = async (type: string, x: number, on: Element = overview) => { await act(async () => { on.dispatchEvent(new MouseEvent(type, { clientX: x, button: 0, bubbles: true })); }); };
    await point("pointerdown", 300);
    await point("pointermove", 500);
    // While the drag goes, the overview shows what it has picked so far: from a fifth of the way in to two fifths.
    const band = overview.querySelector<HTMLElement>("[data-band]")!;
    expect(Number.parseFloat(band.style.left)).toBeCloseTo(20, 6);
    expect(Number.parseFloat(band.style.width)).toBeCloseTo(20, 6);
    await point("pointerup", 600);
    expect(zoomSaid(host)).toBe("+0:44.9 to +1:52.2");
    await click(named(host, "Fit the whole run"));
    // A press and a release in one place is no drag: the bar under it opens.
    const bar = overview.querySelector<HTMLElement>("[data-span='t:0:call_10']")!;
    await point("pointerdown", 330, bar);
    await point("pointerup", 330, bar);
    await click(bar);
    expect(zoomSaid(host)).toBe("");
    expect(panel(host)!.textContent).toContain("python extract_filings.py");
  });

  it("opens a model request to its tokens by kind, the share of its input read from cache, and its cost", async () => {
    const host = await open(TRACE);
    await click(rowOf(host, "+1:29.6")!.querySelector("button"));
    const text = panel(host)!.textContent!;
    expect(text).toContain("Model request");
    expect(text).toContain("80% of input from cache");
    expect(text).toMatch(/Input, not cached2<1%/);
    expect(text).toMatch(/Cache read58,05880%/);
    expect(text).toMatch(/Cache write14,50220%/);
    expect(text).toMatch(/Output1,105–/);
    expect(text).toMatch(/This request73,667\$0\.0884/);
    expect(text).toMatch(/Output speed178 tokens\/s/);
    expect(text).toMatch(/Thinking tokens320 of the output/);
    expect(text).toContain("14% of the run");
    // The calls it made open from here.
    await click([...panel(host)!.querySelectorAll("button")].find((b) => b.textContent?.includes("mcp:crm/lookup_account")));
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("mcp:crm/lookup_account");
    expect(panel(host)!.textContent).toContain("This tool has no price set, so the call ran outside the run's cost.");
  });

  it("opens a tool call to what was charged, its arguments and the head of its result, and back to the request that called it", async () => {
    const host = await open(TRACE);
    await click(rowOf(host, "tradepress.example/2026/northwind-freight-audit\"}")!.querySelector("button"));
    expect(panel(host)!.textContent).toMatch(/Tool call.*Failed/);
    expect(panel(host)!.textContent).toContain("Nothing was charged under this call.");
    expect(panel(host)!.querySelector("pre")!.textContent).toContain('{"url":"https://tradepress.example/2026/northwind-freight-audit"}');
    await click([...panel(host)!.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Result"));
    expect(panel(host)!.querySelector("pre")!.textContent).toContain("HTTP 403 Forbidden");
    await click([...panel(host)!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("claude-sonnet-5-5 · +0:11.5")));
    expect(panel(host)!.textContent).toContain("Model request");
    await click(panel(host)!.querySelector("button[aria-label='Close call details']"));
    expect(panel(host)).toBeNull();
  });

  it("gives the keyboard back to what opened the panel when it closes", async () => {
    const host = await open(TRACE);
    const opened = rowOf(host, "+1:29.6")!.querySelector("button")!;
    opened.focus();
    await click(opened);
    // A span opened from inside the panel keeps the first opener.
    await click([...panel(host)!.querySelectorAll("button")].find((b) => b.textContent?.includes("mcp:crm/lookup_account")));
    await click(panel(host)!.querySelector("button[aria-label='Close call details']"));
    expect(document.activeElement).toBe(opened);
    // Escape closes it too, from inside it.
    await click(opened);
    await act(async () => { panel(host)!.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(panel(host)).toBeNull();
    expect(document.activeElement).toBe(opened);
  });

  it("says a charged call's charge, and that a computer's own time is not metered here", async () => {
    const host = await open(TRACE, { run: { ...RUN, computer: { kind: "browser", provider: "browserbase" } as Run["computer"] }, open: "t:0:call_08" });
    expect(panel(host)!.textContent).toContain("$0.0004 was charged under this call, and is in the run's cost. Time on the run's computer is billed by its provider and is not metered here.");
    expect(panel(host)!.textContent).toContain("<1% of the run");
  });

  it("filters by kind and by words, and says when nothing matches", async () => {
    const host = await open(TRACE);
    await pick(host, "trace-kind", "failed");
    expect(callRows(host).map((tr) => tr.querySelector("button")!.textContent)).toEqual([expect.stringContaining("web_fetch")]);
    await pick(host, "trace-kind", "all");
    await type(host.querySelector<HTMLInputElement>("input[aria-label='Filter calls']")!, "bash pip");
    expect(callRows(host)).toHaveLength(1);
    // How many the filter keeps is said as it changes, where a screen reader hears it.
    expect(host.querySelector("[role=status]")!.textContent).toBe("1 of 24 shown");
    // A span the filter leaves out stays on the overview, dimmed.
    expect(host.querySelector("[data-span='t:0:call_01']")!.className).toContain("opacity-25");
    await type(host.querySelector<HTMLInputElement>("input[aria-label='Filter calls']")!, "no-such-call");
    expect(host.querySelector("[role=status]")!.textContent).toBe("0 of 24 shown");
    expect(host.textContent).toContain("No call matches. Clear the filter to see all 24.");
  });

  it("sorts by a column, the most first, and back to the order they started", async () => {
    const host = await open(TRACE);
    const header = (label: string) => [...host.querySelectorAll("th button")].find((b) => b.textContent === label)!;
    await click(header("Duration"));
    expect(callRows(host)[0]!.textContent).toContain("mcp:mail/send_draft");
    expect(header("Duration").closest("th")!.getAttribute("aria-sort")).toBe("descending");
    await click(header("Cost"));
    expect(callRows(host)[0]!.textContent).toContain("$0.1349");
    await click(header("Cost"));
    expect(callRows(host)[0]!.textContent).toContain("+0:00.0");
  });

  it("the table is one stop for the keyboard: the arrows move from row to row, and an open panel follows", async () => {
    const host = await open(TRACE);
    const body = host.querySelector("section[aria-label='Trace'] > div > table > tbody")!;
    const stops = () => body.querySelectorAll("button[tabindex='0']");
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(callRows(host)[0]!.querySelector("button"));
    const key = async (name: string) => { await act(async () => { body.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); }); await settle(); };
    // With no panel open, the arrows move the keyboard and open nothing.
    await key("ArrowDown");
    expect(document.activeElement).toBe(callRows(host)[1]!.querySelector("button"));
    expect(panel(host)).toBeNull();
    await click(document.activeElement);
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("skill");
    // A screen reader is told the panel opened: it is beside the table, not where the keyboard is.
    expect(host.querySelector("section[aria-label='Trace'] > p[role=status]")!.textContent).toBe("Details shown for skill. Escape closes them.");
    // With one open, it follows the row the keyboard is on.
    await key("End");
    expect(panel(host)!.textContent).toContain("+3:42.4");
    await key("ArrowUp");
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("write");
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(document.activeElement);
    // Escape closes the panel from the table, where the keyboard is, and leaves it on its row.
    const row = document.activeElement;
    await key("Escape");
    expect(panel(host)).toBeNull();
    expect(document.activeElement).toBe(row);
    // With no panel open, Escape is not the table's to take.
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { body.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(false);
  });

  it("a row's name is what it shows, and the cells beside it say how long it took and how it ended", async () => {
    const host = await open(TRACE);
    const button = callRows(host)[1]!.querySelector("button")!;
    // No label of its own in place of its words: speech that names what is seen ("click skill") finds it.
    expect(button.hasAttribute("aria-label")).toBe(false);
    expect(button.textContent).toBe('Toolskill{"skill":"supplier-screening"}');
    expect(button.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent)).toEqual(["4 ms", "OK"]);
    // A cell with no figure is a dash to the eye and a word to a screen reader.
    const cost = [...callRows(host)[1]!.querySelectorAll("td")].at(-2)!;
    expect(cost.querySelector("[aria-hidden]")!.textContent).toBe("–");
    expect(cost.querySelector(".sr-only")!.textContent).toBe("None");
  });

  it("splits a span's time in three: what it waited, how long it ran, and how long what came next took to start", async () => {
    // The browser step: its request answered at 26.6 s, it started at 26.8 s and ran to 39.2 s, and the next request
    // started at 39.4 s.
    const host = await open(TRACE, { open: "t:0:call_08" });
    const timing = () => panel(host)!.querySelector("section[aria-label='Timing']")!;
    expect(timing().textContent).toMatch(/^Timing12\.8 s/);
    expect([...timing().querySelectorAll("dl > div")].map((row) => row.textContent)).toEqual(["Waited to startsince the answer of claude-sonnet-5-5200 ms", "Ran for12.4 s", "Until the next request startedclaude-sonnet-5-5200 ms"]);
    expect(timing().querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Waited to start 200 ms, Ran for 12.4 s, Until the next request started 200 ms");
    // What it waited on opens from here: the request that called it.
    await click(timing().querySelector("button"));
    expect(panel(host)!.textContent).toContain("+0:20.1");
    // That request: the fetch before it ended at 23.3 s and it started at 23.5 s; its call started 200 ms after its answer.
    expect([...timing().querySelectorAll("dl > div")].map((row) => row.textContent)).toEqual(["Waited to startsince the end of web_fetch200 ms", "Answered in3.1 s", "Until its first call startedrun200 ms"]);
  });

  it("breaks the run down: what stands out, where the time and the cost went, and by model and by tool", async () => {
    const host = await open(TRACE);
    await pick(host, "trace-view", "breakdown");
    const section = (label: string) => host.querySelector(`section[aria-label='${label}']`)!;
    // The figures every run has: the first request answered 4.8 s in and the first call started at 5.0 s; the last
    // request sent the most (2 + 85,712 + 6,886 tokens); three searches ran at once from 5.2 s; and the longest stretch
    // with nothing going was the 300 ms after the last search ended.
    expect([...section("Run vitals").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "First answer4.8 sclaude-sonnet-5-5", "First tool call5.0 sskill", "Largest input92.6K tokensRequest 8 of 8", "Most calls at once3First at +0:05.2", "Longest pause300 msAfter web_search",
    ]);
    expect(section("What stands out").textContent).toContain("1 call failed: web_fetch");
    expect(section("What stands out").textContent).toContain("Most expensive request: $0.1349");
    expect(section("Where the time went").textContent).toMatch(/A model answering1m 26s · 38%.*A tool running2m 15s · 60%.*Neither3\.1 s · 1%/);
    expect(section("Where the cost went").textContent).toMatch(/claude-sonnet-5-5\$0\.6132 · 97%.*Tool charges\$0\.0204 · 3%/);
    expect(section("Each request").querySelectorAll("[role=group] button")).toHaveLength(8);
    expect(section("By model").textContent).toMatch(/claude-sonnet-5-5.*81%.*\$0\.6132/);
    const bash = [...section("By tool").querySelectorAll("tbody tr")].find((tr) => tr.textContent?.startsWith("bash"))!;
    expect([...bash.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["2", "0", "47.5 s", "8.9 s", "38.6 s", "38.6 s", "–None", "51.8 KB"]);
    // The Breakdown's parts are headings of the tab, one level under the page's.
    expect([...host.querySelectorAll("section[aria-label='Trace'] h2")].map((h) => h.textContent)).toEqual(["Run vitals", "What stands out", "Where the time went", "Where the cost went", "Each request, in the order they ran", "By model", "By tool"]);
    // A vital opens its span, as a finding does.
    await click([...section("Run vitals").querySelectorAll("button")].find((b) => b.textContent?.includes("Largest input")));
    expect(panel(host)!.textContent).toContain("+3:42.4");
    // What stands out opens its span.
    await click([...section("What stands out").querySelectorAll("button")].find((b) => b.textContent?.includes("Slowest call")));
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("mcp:mail/send_draft");
  });

  it("a run still going: a call that runs and one that waits are drawn to now, and say so", async () => {
    const host = await open(TRACE_LIVE, { live: true, now: TRACE_LIVE_NOW, run: { ...RUN, status: "working", ended_at: null, cost: { usd: null, basis: "estimate", so_far_usd: 0.3583, unpriced: 0 } } });
    expect(tile(host, "Cost so far")?.textContent).toContain("$0.3583");
    expect(rowOf(host, "adverse media")!.textContent).toMatch(/11\.5 s.*Running/);
    expect(rowOf(host, "compliance@northstar.example")!.textContent).toMatch(/11\.4 s.*Waiting/);
    await click(rowOf(host, "compliance@northstar.example")!.querySelector("button"));
    expect(panel(host)!.textContent).toMatch(/11\.4 sso far/);
    expect(panel(host)!.textContent).toContain("Waiting for a person");
    await click([...panel(host)!.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Result"));
    expect(panel(host)!.textContent).toContain("No result yet.");
  });

  it("a call that waits keeps its time while the run waits on a person: the run is not working, and its clock still runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(TRACE_LIVE_NOW);
    // No clock of the test's own: the tab reads the time itself. The run waits for an approval (input_required), so `live` is false.
    const host = await open(TRACE_LIVE, { live: false, now: undefined, run: { ...RUN, status: "input_required", state: "waiting", ended_at: null } });
    expect(rowOf(host, "compliance@northstar.example")!.textContent).toMatch(/11\.4 s.*Waiting/);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(rowOf(host, "compliance@northstar.example")!.textContent).toMatch(/16\.4 s.*Waiting/);
    expect(tile(host, "Time")?.textContent).toContain("1m 53s");
  });

  it("a run that ended draws a span still read as going to the run's end, never to today", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(TRACE_LIVE_NOW + 86_400_000);
    const host = await open(TRACE_LIVE, { now: undefined, run: { ...RUN, status: "cancelled", ended_at: new Date(TRACE_LIVE_NOW).toISOString() } });
    expect(rowOf(host, "compliance@northstar.example")!.textContent).toMatch(/11\.4 s/);
    expect(tile(host, "Time")?.textContent).toContain("1m 48s");
  });

  it("says how many requests reported no tokens, and that a free model's requests cost $0", async () => {
    const spans = TRACE.spans.map((s) => (s.id === "m:0:9" ? { ...s, tokens: null, usd: null, status: "interrupted" as const } : s.kind === "model" ? { ...s, usd: 0 } : { ...s, usd: null, charged: false }));
    const host = await open({ ...TRACE, spans });
    expect(tile(host, "Tokens")?.textContent).toContain("1 request reported none");
    await pick(host, "trace-view", "breakdown");
    const cost = host.querySelector("section[aria-label='Where the cost went']")!.textContent!;
    expect(cost).toContain("Everything this trace knows the cost of was $0.");
    await pick(host, "trace-chart", "cost");
    expect(host.querySelector("section[aria-label='Each request']")!.textContent).toContain("tallest: $0");
  });

  it("a CLI harness's run: says its record keeps no model request, and shows its calls alone", async () => {
    const host = await open(TRACE_CLI);
    expect(host.textContent).toContain("This run's harness keeps no record of each model request");
    expect(tile(host, "Model requests")?.textContent).toMatch(/–NoneNot kept by this harness/);
    expect([...overviewOf(host).querySelectorAll("p.caps")].map((p) => p.textContent)).toEqual(["Tool calls (5)"]);
    expect(callRows(host)).toHaveLength(5);
  });

  it("splits a CLI harness's run's cost by line from the server's booking: by model, by the vendor that charged, by browser provider", async () => {
    const readUsage = vi.fn(async () => USAGE_CLI);
    const host = await open(TRACE_CLI, { readUsage, view: "breakdown" });
    expect(readUsage).toHaveBeenCalledTimes(1);
    const cost = host.querySelector("section[aria-label='Where the cost went']")!;
    // The run's total beside the heading: one of its charges is not known, so it is what is known, never a whole figure.
    expect(cost.querySelector("h2")!.parentElement!.textContent).toBe("Where the cost wentUnknown, $0.4379 known");
    // One part a line, named by its model, the vendor that charged for a tool, or the browser provider.
    expect([...cost.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["claude-sonnet-5-5$0.4125 · 94%", "monid · tools$0.0150 · 3%", "browserbase · browser timeUnknown, $0.0104 known · 2%"]);
    const table = cost.querySelector("[role=region]")!;
    expect(document.getElementById(table.getAttribute("aria-labelledby")!)!.textContent).toBe("Cost by line");
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Line", "Quantity", "Cost", "Basis"]);
    expect([...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([
      ["claude-sonnet-5-5Tokens", "184,220 tokens", "$0.4125", "Reported"],
      ["monid · toolsTool charges2 calls not metered: no price is set, so they are outside the cost", "3 calls", "$0.0150", "Estimate"],
      ["browserbase · browser timeBrowser time", "312 seconds", "Unknown, $0.0104 known", "Estimate"],
    ]);
    // A charge not known is never $0.
    expect(cost.textContent).not.toMatch(/\$0(?![.\d])/);
    // The lines are a part of Where the cost went, not a heading of the tab.
    expect([...host.querySelectorAll("h2, h3")].map((h) => h.textContent)).not.toContain("Cost by line");
  });

  it("shows a computer's time by provider and resource, its unit and the time no claim held, and an unpriced resource as no price, never $0", async () => {
    const compute = (resource: "vcpu" | "gpu" | "disk", quantity: number, unit: "vcpu_second" | "gpu_second" | "gb_month", usd: number | null, extra = {}) =>
      ({ meter: "compute_time" as const, model: null, provider: "daytona", charged_by: "daytona", quantity, unit, basis: usd === null ? ("unpriced" as const) : ("estimate" as const), attempt: 1, billable: true, usd, resource, gpu_type: resource === "gpu" ? "H100" : null, unheld_quantity: 0, open_computers: 0, ...extra });
    const usage = { ...USAGE_CLI, total: { usd: 0.4125 }, lines: [USAGE_CLI.lines![0]!, compute("vcpu", 3600, "vcpu_second", 0.0504, { unheld_quantity: 1200 }), compute("gpu", 900, "gpu_second", null), compute("disk", 0.000064, "gb_month", null, { open_computers: 1 })] };
    const host = await open(TRACE_CLI, { readUsage: vi.fn(async () => usage), view: "breakdown" });
    const table = host.querySelector("section[aria-label='Where the cost went'] [role=region]")!;
    expect([...table.querySelectorAll("tbody tr")].slice(1).map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([
      ["daytona · vCPUComputer time1,200 vCPU-seconds no claim held: outside the cost", "3,600 vCPU-seconds", "$0.0504", "Estimate"],
      ["daytona · H100 GPUComputer time", "900 GPU-seconds", "Unknown", "No price"],
      ["daytona · diskComputer time1 computer still running when read", "0.000064 GB-months", "Unknown", "No price"],
    ]);
  });

  it("says which attempt a cost line was made in and what its repeated requests cost, where an attempt was cut and another took over", async () => {
    const host = await open(TRACE_CLI, { readUsage: vi.fn(async () => USAGE_REDO), view: "breakdown" });
    const cost = host.querySelector("section[aria-label='Where the cost went']")!;
    expect([...cost.querySelectorAll("[role=region] tbody tr")].map((tr) => tr.children[0]!.textContent)).toEqual([
      "claude-sonnet-5-5TokensAttempt 1: requests cut before they answered, sent again", "claude-sonnet-5-5TokensAttempt 2", "monid · toolsTool chargesAttempt 2",
    ]);
    // The split's parts say the attempt too: two of them are one model's.
    expect([...cost.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["claude-sonnet-5-5 · attempt 1 · sent again$0.0312 · 7%", "claude-sonnet-5-5 · attempt 2$0.4125 · 90%", "monid · tools · attempt 2$0.0150 · 3%"]);
    // The server's own sum of the repeated requests' lines, with its share of the run's cost: $0.0312 of $0.4587.
    expect(cost.querySelector("[data-redo]")!.textContent).toMatch(/^Requests sent twice: \$0\.0312 · 7%\. An attempt at a turn was cut/);
    // Only what the cut attempt had not finished was sent again: its paid calls are not said to be repeated.
    expect(cost.querySelector("[data-redo]")!.textContent).toContain("its answered requests and finished paid calls were reused");
    expect([...host.querySelectorAll("section[aria-label='What stands out'] li")].map((li) => li.textContent)).toContain("$0.0312 went on requests sent twice1 of the run's 3 cost lines is of requests an attempt sent and was cut before they answered, which the next attempt sent again: 7% of the run's cost.");
  });
  it("tells two parts of one model and one attempt apart: the requests that answered, and the ones cut and sent again", async () => {
    // An attempt answered some requests before another was cut: both lines are attempt 1's, one of them not billable.
    const usage = { ...USAGE_REDO, lines: [USAGE_REDO.lines![0]!, { ...USAGE_REDO.lines![1]!, attempt: 1 }, USAGE_REDO.lines![2]!] };
    const host = await open(TRACE_CLI, { readUsage: vi.fn(async () => usage), view: "breakdown" });
    expect([...host.querySelectorAll("section[aria-label='Where the cost went'] ul li")].map((li) => li.textContent!.replace(/\$.*/, ""))).toEqual(["claude-sonnet-5-5 · attempt 1 · sent again", "claude-sonnet-5-5 · attempt 1", "monid · tools · attempt 2"]);
  });
  it("says a repeated request's cost as at most, with no share, where it is what was held for a request cut before its usage", async () => {
    const usage = { ...USAGE_REDO, lines: [{ ...USAGE_REDO.lines![0]!, upper_bound: true as const }, ...USAGE_REDO.lines!.slice(1)] };
    const host = await open(TRACE_CLI, { readUsage: vi.fn(async () => usage), view: "breakdown" });
    expect(host.querySelector("[data-redo]")!.textContent).toMatch(/^Requests sent twice: at most \$0\.0312\. An attempt/);
  });
  it("says nothing of attempts on a run none of whose attempts was cut", async () => {
    const host = await open(TRACE_CLI, { readUsage: vi.fn(async () => USAGE_CLI), view: "breakdown" });
    expect(host.querySelector("[data-redo]")).toBeNull();
    expect(host.textContent).not.toMatch(/Attempt \d|sent twice|sent again/);
  });

  it("draws the run's computers and browser sessions under its calls, each on the same time axis, and lists them in the Breakdown", async () => {
    const host = await open(TRACE, { readUsage: vi.fn(async () => USAGE_MACHINES) });
    const lanes = [...overviewOf(host).querySelectorAll("[data-stretches]")];
    expect(lanes.map((lane) => lane.querySelector("p")!.textContent)).toEqual(["Computers (1)", "Browser sessions (1)"]);
    // The sandbox outlasts the window at both ends; the session is a quarter of the way in, for a quarter of it.
    const [computer, session] = lanes.map((lane) => lane.querySelector<HTMLElement>("[data-stretch]")!);
    expect([computer!.style.left, computer!.style.width, computer!.title]).toEqual(["0%", "100%", "daytona sandbox, up 3m 59s, from 2.4 s before the first request"]);
    expect([Number.parseFloat(session!.style.left).toFixed(1), Number.parseFloat(session!.style.width).toFixed(1), session!.title]).toEqual(["25.2", "26.7", "browserbase browser, up 1m 00s, from +0:56.6"]);
    // A stretch is no call: a press on one opens no panel, and the overview's words count them.
    await click(computer);
    expect(panel(host)).toBeNull();
    expect(overviewOf(host).querySelector("[role=img]")!.getAttribute("aria-label")).toMatch(/Under them, 1 computer and 1 browser session: the Breakdown lists each\.$/);

    await pick(host, "trace-view", "breakdown");
    const table = host.querySelector("section[aria-label='Computers and browser sessions'] table")!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["What", "Started", "Up for", "In the run's cost", "Note"]);
    expect([...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([
      ["daytona sandbox2 vCPU · 4 GB · 10 GB disk", "2.4 s before the first request", "3m 59s", "3m 46s", "–None"],
      ["browserbase browserbb_9d2c41", "+0:56.6", "1m 00s", "1m 00s", "Closed by the agent"],
    ]);
  });
  it("lists a session whose start was never recorded, with what was charged for it, and draws no bar for it", async () => {
    // Its runner died before the release that writes a session's start and end: the charge is still the run's.
    const lost = { ...USAGE_MACHINES.browser_sessions![0]!, tag: "browser-2", provider_session_id: null, started_at: null, ended_at: null, release_reason: "lost", charged_seconds: 42 };
    const usage = { ...USAGE_MACHINES, computer_intervals: [], browser_sessions: [lost, USAGE_MACHINES.browser_sessions![0]!] };
    const host = await open(TRACE, { readUsage: vi.fn(async () => usage) });
    expect(overviewOf(host).querySelectorAll("[data-stretch]")).toHaveLength(1);
    await pick(host, "trace-view", "breakdown");
    expect([...host.querySelectorAll("section[aria-label='Computers and browser sessions'] tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([
      ["browserbase browserbb_9d2c41", "+0:56.6", "1m 00s", "1m 00s", "Closed by the agent"],
      ["browserbase browser", "Not recorded", "Not recorded", "42.0 s", "Lost"],
    ]);
  });
  it("says how long a computer with no end recorded had been up when the run ended, never its age now, and draws no session opened after the trace's last span", async () => {
    // Its delete failed: it may be up still, hours after. The usage covers the run to its end (228 s in; the sandbox was made 1 s in).
    const open_ = { ...USAGE_MACHINES.computer_intervals![0]!, ended_at: null };
    // A session opened after the window's end (a long run's trace holds its first spans only).
    const later = { ...USAGE_MACHINES.browser_sessions![0]!, tag: "browser-9", started_at: new Date(TRACE_START + 300_000).toISOString(), ended_at: new Date(TRACE_START + 330_000).toISOString(), charged_seconds: 30 };
    const usage = { ...USAGE_MACHINES, ended_at: new Date(TRACE_END).toISOString(), computer_intervals: [open_], browser_sessions: [later] };
    // The page is opened a day later: the run's own end still dates the figure.
    const host = await open(TRACE, { readUsage: vi.fn(async () => usage), now: TRACE_END });
    expect([...overviewOf(host).querySelectorAll("[data-stretches]")].map((lane) => lane.querySelector("p")!.textContent)).toEqual(["Computers (1)"]);
    await pick(host, "trace-view", "breakdown");
    expect([...host.querySelectorAll("section[aria-label='Computers and browser sessions'] tbody tr")].map((tr) => [tr.children[0]!.textContent, tr.children[2]!.textContent])).toEqual([
      ["daytona sandbox2 vCPU · 4 GB · 10 GB disk", "No end recorded · up 3m 47s when the run ended"],
      ["browserbase browserbb_9d2c41", "30.0 s"],
    ]);
  });
  it("lists a run's computers though its trace has no request and no call, against the run's start", async () => {
    // A run that made its computer and failed before its first request: the sandbox was made 1 s after the run began.
    const empty = { run_id: TRACE.run_id, model_requests: "priced" as const, spans: [], dropped: 0 };
    const host = await open(empty, { readUsage: vi.fn(async () => ({ ...USAGE_MACHINES, lines: [], browser_sessions: [] })) });
    expect(host.textContent).toContain("This run made no model request and called no tool.");
    expect([...host.querySelectorAll("section[aria-label='Computers and browser sessions'] tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([
      ["daytona sandbox2 vCPU · 4 GB · 10 GB disk", "+0:01.0", "3m 59s", "3m 46s", "–None"],
    ]);
  });
  it("draws no such lane and lists none for a run that made no computer and opened no browser, or whose usage is not read", async () => {
    for (const readUsage of [vi.fn(async () => USAGE_CLI), undefined]) {
      const host = await open(TRACE, { readUsage, view: "breakdown" });
      expect(host.querySelector("section[aria-label='Computers and browser sessions']")).toBeNull();
      await pick(host, "trace-view", "calls");
      expect(overviewOf(host).querySelector("[data-stretches]")).toBeNull();
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });

  it("shows lines only as read at the run's version now: lines left by a reread that failed after the run moved are not shown as its own", async () => {
    const host = await open(TRACE, { readUsage: async () => USAGE_CLI, view: "breakdown" });
    const cost = () => host.querySelector("section[aria-label='Where the cost went']")!;
    expect(cost().textContent).toContain("Cost by line");
    // A follow-up moves the run; the reread fails.
    act(() => root!.render(createElement(RunTrace, { run: RUN, read: async () => TRACE, readUsage: async () => { throw new Error("offline"); }, version: "2", live: false, now: TRACE_END, view: "breakdown" })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    await settle();
    expect(cost().textContent).toMatch(/claude-sonnet-5-5\$0\.6132 · 97%/);
    expect(cost().textContent).not.toContain("Cost by line");
  });

  it("shows a stopped run's lines, though the run reads no end (a follow-up may take it on) (#3281 review)", async () => {
    const host = await open(TRACE, { run: { ...RUN, status: "input_required", state: "waiting", ended_at: null }, readUsage: async () => USAGE_CLI, view: "breakdown" });
    expect(host.querySelector("section[aria-label='Where the cost went']")!.textContent).toContain("Cost by line");
  });

  it("gives a CLI run that called no tool its cost by line, though its trace has no span", async () => {
    const host = await open({ ...TRACE_CLI, spans: [] }, { readUsage: async () => USAGE_CLI });
    const cost = host.querySelector("section[aria-label='Where the cost went']")!;
    expect(cost.querySelector("h2")!.parentElement!.textContent).toBe("Where the cost wentUnknown, $0.4379 known");
    expect([...cost.querySelectorAll("tbody tr")].map((tr) => tr.children[0]!.textContent)).toEqual(["claude-sonnet-5-5Tokens", "monid · toolsTool charges2 calls not metered: no price is set, so they are outside the cost", "browserbase · browser timeBrowser time"]);
    expect(host.textContent).not.toContain("This run made no model request and called no tool.");
  });

  it("says a line's cost at most where it is a bound, and the provider its tokens went to", async () => {
    const usage: RunUsage = { ...USAGE_CLI, total: { usd: 0.4379, upper_bound: true }, lines: [{ ...USAGE_CLI.lines![0]!, provider: "anthropic", usd: 0.4125, upper_bound: true }] };
    const host = await open(TRACE_CLI, { readUsage: async () => usage, view: "breakdown" });
    const cost = host.querySelector("section[aria-label='Where the cost went']")!;
    expect(cost.querySelector("h2")!.parentElement!.textContent).toBe("Where the cost wentat most $0.4379");
    expect([...cost.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent))).toEqual([["claude-sonnet-5-5Tokens · sent to anthropic", "184,220 tokens", "at most $0.4125", "Reported"]]);
  });

  it("with no lines yet keeps the trace's own split and says why: the run is at work, or its cost can't be split", async () => {
    const running: RunUsage = { ...USAGE_CLI, ended_at: null, total: null, lines: null, browser_sessions: null, computer_intervals: null, infra_usd: null, reason: "running" };
    const host = await open(TRACE, { readUsage: async () => running, view: "breakdown" });
    const cost = () => host.querySelector("section[aria-label='Where the cost went']")!;
    expect(cost().textContent).toMatch(/claude-sonnet-5-5\$0\.6132 · 97%.*Tool charges\$0\.0204 · 3%/);
    expect(cost().textContent).toContain("Cost by line appears when the run ends.");
    expect(cost().querySelector("[role=region]")).toBeNull();
    act(() => root?.unmount());
    const cli = await open(TRACE_CLI, { readUsage: async () => ({ ...running, reason: "not_booked" as const }), view: "breakdown" });
    expect(cli.querySelector("section[aria-label='Where the cost went']")!.textContent).toContain("This run's cost is its harness's own figure, so it can't be split by line.");
  });

  it("a usage read that fails leaves the trace's own split, and no error", async () => {
    const host = await open(TRACE, { readUsage: async () => { throw new Error("no such route"); }, view: "breakdown" });
    const cost = host.querySelector("section[aria-label='Where the cost went']")!;
    expect(cost.textContent).toMatch(/claude-sonnet-5-5\$0\.6132 · 97%/);
    expect(host.textContent).not.toContain("no such route");
  });

  it("a workflow run's requests carry tokens and no cost: none is said, and the panel says why", async () => {
    const spans = TRACE.spans.map((s) => (s.kind === "model" ? { ...s, usd: null } : s));
    const host = await open({ ...TRACE, model_requests: "tokens_only", spans }, { open: "m:0:24" });
    expect(rowOf(host, "+1:29.6")!.textContent).not.toContain("Unknown");
    expect(panel(host)!.textContent).toContain("This run's cost is booked for the whole run, so this request carries tokens only.");
    expect(tile(host, "Cost, estimated")?.textContent).toContain("tools $0.0204");
    // A decision of the workflow is a request with a cost of its own: said on its row, in its panel and in the tile.
    act(() => root?.unmount());
    const decided = spans.map((s) => (s.id === "m:0:9" ? { ...s, id: "d:dec_1:0", decision: true, name: "typesafe/jev-1", agent_label: "is it urgent?", usd: 0.0003 } : s));
    const flow = await open({ ...TRACE, model_requests: "tokens_only", spans: decided }, { open: "d:dec_1:0" });
    expect(rowOf(flow, "typesafe/jev-1")!.textContent).toMatch(/is it urgent\?.*\$0\.0003/);
    expect(panel(flow)!.textContent).toContain("The cost is what the run recorded for this request: one figure for all its tokens.");
    expect(tile(flow, "Cost, estimated")?.textContent).toContain("requests $0.0003 · tools $0.0204");
    expect(panel(flow)!.textContent).toMatch(/^Decision/);
    // A decision with no known cost reads Unknown, and the subtotal says one is: never a whole-looking figure without it.
    act(() => root?.unmount());
    const unknown = await open({ ...TRACE, model_requests: "tokens_only", spans: [...decided.map((s) => (s.id === "m:0:16" ? { ...s, id: "d:dec_2:0", decision: true, name: "typesafe/jev-1", usd: null } : s))] }, { open: "d:dec_2:0" });
    expect(rowOf(unknown, "+0:20.1")!.textContent).toContain("Unknown");
    expect(panel(unknown)!.textContent).toContain("This decision's cost is unknown: its receipt keeps none.");
    expect(tile(unknown, "Cost, estimated")?.textContent).toContain("requests $0.0003 + 1 unknown");
  });

  it("copies a call's arguments or result as shown", async () => {
    const wrote: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (words: string) => { wrote.push(words); } } });
    const host = await open(TRACE, { open: "t:0:call_10" });
    const copy = () => [...panel(host)!.querySelectorAll("button")].find((b) => b.textContent === "Copy" || b.textContent === "Copied")!;
    await click(copy());
    expect(wrote).toEqual(['{"command":"python extract_filings.py --company NF-204418"}']);
    expect(copy().textContent).toBe("Copied");
    await click([...panel(host)!.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Result"));
    await click(copy());
    expect(wrote[1]).toBe("Parsed 14 filings\ndirectors: 2\ncharges: 0");
  });

  it("a long run lists its first 300 rows until asked for the rest; every span stays on the overview", async () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ ...TRACE.spans[1]!, id: `t:0:n${i}`, tool_use_id: `n${i}`, started_at: new Date(TRACE_START + i * 100).toISOString(), ended_at: new Date(TRACE_START + i * 100 + 50).toISOString() }));
    const host = await open({ ...TRACE, spans: many });
    expect(callRows(host)).toHaveLength(300);
    expect(host.querySelectorAll("[data-overview] [data-span]")).toHaveLength(320);
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Show all 320"));
    expect(callRows(host)).toHaveLength(320);
  });

  it("every pane of the tab that scrolls is the place its out-of-flow content is set against, so none of it scrolls the page", async () => {
    // A Segmented's hidden radios are absolutely placed. Under a pane that is not `relative` they are set against the
    // page: the one beside the Breakdown's chart, far down that pane, made the whole page scroll with nothing under it.
    const host = await open(TRACE, { open: "m:0:24", view: "breakdown" });
    expect(host.querySelector("section[aria-label='Each request'] input[type=radio]")).toBeTruthy();
    const scrolls = [...host.querySelectorAll<HTMLElement>("*")].filter((el) => /(^|\s)(xl:)?overflow-auto(\s|$)/.test(el.className) && !/overflow-x-auto/.test(el.className));
    expect(scrolls.map((el) => el.getAttribute("aria-label") ?? el.tagName)).toEqual(["DIV", "Trace", "Call details"]);
    for (const pane of scrolls) expect(pane.className.split(/\s+/)).toContain("relative");
    // Each hidden radio's nearest positioned ancestor is a pane of the tab, never something outside it.
    for (const radio of host.querySelectorAll("input.sr-only")) expect(radio.closest(".relative")?.closest("[data-scroll-pane]")).toBe(host.querySelector("[data-scroll-pane]"));
  });

  it("beside an open panel the table's time axis and its Size column show by the width of the table's pane, never the window's", async () => {
    // A window 1536 wide leaves the table 740 px beside the panel, and with its axis and Size it needs some 920: shown
    // from that window width on (`2xl:`), they made the pane scroll sideways until the window was some 1700 wide.
    // (jsdom lays nothing out: the widths themselves are measured in a browser, e2e/flows/dev-tools-panel-width.mjs.)
    const host = await open(TRACE, { open: "m:0:24" });
    const pane = host.querySelector("section[aria-label='Trace']")!;
    expect(pane.className.split(/\s+/)).toContain("@container");
    const table = pane.querySelector(":scope > div > table")!;
    const at = [...table.querySelectorAll("thead th")].findIndex((th) => th.textContent === "Size");
    const axis = [...table.querySelectorAll("[data-axis]")];
    const size = [...table.querySelectorAll("tr")].map((tr) => tr.children[at]!);
    expect([axis.length, size.length]).toEqual([25, 25]);
    // Hidden, shown under `xl` (the panel is under the table there) and shown again once the pane is wide enough.
    for (const cell of axis) expect(cell.className.split(/\s+/).filter((c) => /(^|:)(hidden|table-cell)$/.test(c))).toEqual(["hidden", "md:max-xl:table-cell", "@4xl:table-cell"]);
    for (const cell of size) expect(cell.className.split(/\s+/).filter((c) => /(^|:)(hidden|table-cell)$/.test(c))).toEqual(["hidden", "max-xl:table-cell", "@5xl:table-cell"]);
    // With none open the table has the page to itself: its axis from `md` on, its Size column always.
    await click(named(host, "Close call details"));
    expect(panel(host)).toBeNull();
    for (const cell of table.querySelectorAll("[data-axis]")) expect(cell.className.split(/\s+/).filter((c) => /(^|:)(hidden|table-cell)$/.test(c))).toEqual(["hidden", "md:table-cell"]);
    for (const tr of table.querySelectorAll("tr")) expect(tr.children[at]!.className).not.toMatch(/hidden|table-cell/);
  });

  it("a cell's hidden words are set against the table's own box, so the ones scrolled out of view do not scroll the pane sideways", async () => {
    // A dash reads "None" to a screen reader, in words placed out of the flow. Set against the pane, the ones in the part
    // of a wide table scrolled out of view made the pane scroll sideways under `xl`, over nothing.
    const host = await open(TRACE);
    const table = host.querySelector("section[aria-label='Trace'] > div > table")!;
    // The sample's sixteen calls: five were charged and one says it is not metered, so ten have a dash for a cost.
    const hidden = [...table.querySelectorAll("td .sr-only")];
    expect(hidden.map((words) => words.textContent)).toEqual(Array(10).fill("None"));
    for (const words of hidden) expect(words.closest(".relative")).toBe(table.parentElement);
  });

  it("says when spans were left out, and when the run made none", async () => {
    expect((await open({ ...TRACE, dropped: 310 })).textContent).toContain("This is the run's first 24 requests and calls. 310 later ones are not shown.");
    act(() => root?.unmount());
    expect((await open({ run_id: "run_7f3a9c2e", model_requests: "priced", spans: [], dropped: 0 })).textContent).toContain("This run made no model request and called no tool.");
  });

  it("a read that fails says so with the server's words and reads again on Try again; a later failure keeps what was read", async () => {
    let fail: string | null = "The run's journal could not be read.";
    const read = vi.fn(async () => { if (fail) throw new Error(fail); return TRACE; });
    const host = await open(read);
    expect(host.querySelector("[role=alert]")!.textContent).toMatch(/The trace could not be read.*The run's journal could not be read\./);
    fail = null;
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Try again"));
    expect(callRows(host)).toHaveLength(24);
    // The run moves: the trace is read again; that read failing leaves the last trace shown.
    fail = "gone";
    vi.useFakeTimers();
    act(() => root!.render(createElement(RunTrace, { run: RUN, read, version: "2", live: false, now: TRACE_END })));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    expect(read).toHaveBeenCalledTimes(3);
    expect(callRows(host)).toHaveLength(24);
    expect(host.querySelector("[role=alert]")).toBeNull();
  });
});

describe("reading the trace as the run moves", () => {
  it("drops no read: a run that moves while a read is out shows that read when it lands, then reads once more", async () => {
    const waiting: ((trace: Trace) => void)[] = [];
    const read = vi.fn(() => new Promise<Trace>((resolve) => { waiting.push(resolve); }));
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    vi.useFakeTimers();
    const draw = (version: string) => act(() => root!.render(createElement(RunTrace, { run: RUN, read, version, live: true, now: TRACE_END })));
    draw("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(read).toHaveBeenCalledTimes(1);
    // The run moves three times while the first read is out: no second read starts, and the first is not thrown away.
    for (const version of ["2", "3", "4"]) { draw(version); await act(async () => { await vi.advanceTimersByTimeAsync(200); }); }
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { waiting[0]!({ ...TRACE, spans: TRACE.spans.slice(0, 5) }); await vi.advanceTimersByTimeAsync(0); });
    expect(callRows(host)).toHaveLength(5);
    // Then one more read for the moves it missed, half a second after.
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { waiting[1]!(TRACE); await vi.advanceTimersByTimeAsync(0); });
    expect(callRows(host)).toHaveLength(24);
    // Moves in a burst with no read out are one read, half a second after the first of them.
    for (const version of ["5", "6", "7"]) { draw(version); await act(async () => { await vi.advanceTimersByTimeAsync(100); }); }
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(read).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("the run page", () => {
  const page = async (readTrace?: () => Promise<Trace>) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run: RUN, agentName: "supplier-screening", messages: messageFeatures, harnessSteers: true, rows: [], files: [], readTrace, traceAt: { now: TRACE_END } })));
    await settle();
    return host;
  };
  const tab = (host: Element, label: string) => [...host.querySelectorAll("[role=tab]")].find((t) => t.textContent === label);

  it("offers Dev tools where the trace can be read, and reads it only once the tab is open", async () => {
    const read = vi.fn(async () => TRACE);
    const host = await page(read);
    expect(tab(host, "Dev tools")).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    await click(tab(host, "Dev tools"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(callRows(host)).toHaveLength(24);
  });

  it("ties each view's body to its tab: the open tab names a panel that is there, and the panel names its tab", async () => {
    const host = await page(async () => TRACE);
    for (const label of ["Report", "Timeline", "Dev tools"]) {
      await click(tab(host, label));
      const body = document.getElementById(tab(host, label)!.getAttribute("aria-controls")!);
      expect(body?.getAttribute("role"), label).toBe("tabpanel");
      expect(body!.getAttribute("aria-labelledby"), label).toBe(tab(host, label)!.id);
    }
  });

  it("reads the trace again when a row changes in place: a charge folded into a call's own row adds no row", async () => {
    const read = vi.fn(async () => TRACE);
    const row = { id: "0:1", seq: 1, kind: "tool_use", timestamp: RUN.created_at, created_at: RUN.created_at, summary: "Opened a page", agent_label: null, tool_name: "run", tool_use_id: "call_08", tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null } as const;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const draw = (rows: React.ComponentProps<typeof RunDetail>["rows"]) => act(() => root!.render(createElement(RunDetail, { run: RUN, agentName: "supplier-screening", messages: messageFeatures, harnessSteers: true, rows, files: [], readTrace: read, tab: "trace", traceAt: { now: TRACE_END } })));
    const held = [row];
    draw(held);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    // The same rows drawn again: nothing moved, nothing is read.
    draw(held);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    // The same number of rows, one of them changed (its charge): read again, half a second after.
    vi.useFakeTimers();
    draw([{ ...row, usage: { usd: 0.0004, requests: 0 } }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads the run's usage lines beside its trace once the Dev tools tab is open", async () => {
    const readUsage = vi.fn(async () => USAGE_CLI);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run: RUN, agentName: "supplier-screening", messages: messageFeatures, harnessSteers: true, rows: [], files: [], readTrace: async () => TRACE_CLI, readUsage, traceAt: { now: TRACE_END, view: "breakdown" } })));
    await settle();
    expect(readUsage).not.toHaveBeenCalled();
    await click(tab(host, "Dev tools"));
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(host.querySelector("section[aria-label='Where the cost went'] [role=region]")!.textContent).toContain("monid · tools");
  });

  it("has no Dev tools tab where it cannot", async () => {
    expect(tab(await page(), "Dev tools")).toBeUndefined();
  });
});
