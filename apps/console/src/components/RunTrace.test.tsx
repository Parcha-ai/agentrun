import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { RunTrace } from "@/components/RunTrace";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_LIVE, TRACE_LIVE_NOW, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { messageFeatures } from "@/fixtures";
import type { Run, RunTrace as Trace } from "@/lib/v2";

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
const tile = (host: Element, label: string) => [...host.querySelectorAll("p.caps")].find((p) => p.textContent === label)?.parentElement;
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

  it("draws each span on the time axis, a lane for requests and one for calls; a bar opens its span", async () => {
    const host = await open(TRACE);
    const lanes = [...host.querySelectorAll("section[aria-label='Calls on the time axis'] p.caps")].map((p) => p.textContent);
    expect(lanes).toEqual(["Model requests (8)", "Tool calls (16)"]);
    const bar = host.querySelector<HTMLElement>("button[aria-label^='Tool bash, ok, 38.6 s']")!;
    expect(bar.style.left).toBe(`${((54_200 - 3400) / 224_500) * 100}%`);
    await click(bar);
    expect(panel(host)!.textContent).toContain("python extract_filings.py");
    expect(bar.getAttribute("aria-pressed")).toBe("true");
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
    // A span the filter leaves out stays on the time axis, dimmed.
    expect(host.querySelector("button[aria-label^='Tool skill']")!.className).toContain("opacity-25");
    await type(host.querySelector<HTMLInputElement>("input[aria-label='Filter calls']")!, "no-such-call");
    expect(host.querySelector("[role=status]")!.textContent).toBe("No call matches. Clear the filter to see all 24.");
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

  it("moves from span to span on the time axis with the arrow keys, one stop for the keyboard", async () => {
    const host = await open(TRACE);
    const axis = host.querySelector("[role=group][aria-label^='Calls on the time axis']")!;
    expect(axis.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
    const key = async (name: string) => { await act(async () => { axis.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); }); await settle(); };
    await key("ArrowRight");
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("skill");
    await key("End");
    expect(panel(host)!.textContent).toContain("+3:42.4");
    await key("ArrowLeft");
    expect(panel(host)!.querySelector("h2")!.textContent).toBe("write");
    expect(axis.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
  });

  it("breaks the run down: what stands out, where the time and the cost went, and by model and by tool", async () => {
    const host = await open(TRACE);
    await pick(host, "trace-view", "breakdown");
    const section = (label: string) => host.querySelector(`section[aria-label='${label}']`)!;
    expect(section("What stands out").textContent).toContain("1 call failed: web_fetch");
    expect(section("What stands out").textContent).toContain("Most expensive request: $0.1349");
    expect(section("Where the time went").textContent).toMatch(/A model answering1m 26s · 38%.*A tool running2m 15s · 60%.*Neither3\.1 s · 1%/);
    expect(section("Where the cost went").textContent).toMatch(/claude-sonnet-5-5\$0\.6132 · 97%.*Tool charges\$0\.0204 · 3%/);
    expect(section("Each request").querySelectorAll("[role=group] button")).toHaveLength(8);
    expect(section("By model").textContent).toMatch(/claude-sonnet-5-5.*81%.*\$0\.6132/);
    const bash = [...section("By tool").querySelectorAll("tbody tr")].find((tr) => tr.textContent?.startsWith("bash"))!;
    expect([...bash.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["2", "0", "47.5 s", "8.9 s", "38.6 s", "38.6 s", "–", "51.8 KB"]);
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
    expect(tile(host, "Model requests")?.textContent).toMatch(/–Not kept by this harness/);
    expect([...host.querySelectorAll("section[aria-label='Calls on the time axis'] p.caps")].map((p) => p.textContent)).toEqual(["Tool calls (5)"]);
    expect(callRows(host)).toHaveLength(5);
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

  it("a long run lists its first 300 rows until asked for the rest; every span stays on the time axis", async () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ ...TRACE.spans[1]!, id: `t:0:n${i}`, tool_use_id: `n${i}`, started_at: new Date(TRACE_START + i * 100).toISOString(), ended_at: new Date(TRACE_START + i * 100 + 50).toISOString() }));
    const host = await open({ ...TRACE, spans: many });
    expect(callRows(host)).toHaveLength(300);
    expect(host.querySelectorAll("[role=group][aria-label^='Calls on the time axis'] button")).toHaveLength(320);
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

  it("has no Dev tools tab where it cannot", async () => {
    expect(tab(await page(), "Dev tools")).toBeUndefined();
  });
});
