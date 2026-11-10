import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, archivedAgents, editorCaps, recorded, runFixture, runNames } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { ClientError, type FieldIssue } from "@/lib/client";
import { ANALYTICS, statsWith } from "./AgentAnalytics.sample";
import type { Places } from "@/lib/place";
import type { Run, TimelinePage } from "@/lib/v2";

// An agent's own page: its current revision's settings in the header, its runs, and a workflow agent's graph, read-only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runsOf = (slug: string) => recorded<{ runs: Run[] }>(`agent.${slug}.runs`).body.runs;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
/** Waits (up to three seconds) for what a timer-paced read brings, e.g. the next timeline page or a read tried again. */
const until = async (ok: () => boolean) => { for (let i = 0; i < 150 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); expect(ok()).toBe(true); };
/** A recorded completed run cut in two, as its agent's latest run: its first three steps while it works, then the rest as
 *  it completes, which come once `release` is called. `reread` answers the run's record read again. */
async function splitRun(reread: (done: Run) => Promise<Run> = async (done) => done) {
  const done = runFixture("run.completed.idle.1");
  const running: Run = { ...done.run, status: "working", state: "working", ended_at: null, result: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } };
  const first: TimelinePage = { ...done.page, status: "working", state: "working", rows: done.page.rows.slice(0, 3), final: false, next_after: 3 };
  const rest: TimelinePage = { ...done.page, reset: false, rows: done.page.rows.slice(3) };
  let release!: () => void;
  const ends = new Promise<void>((r) => { release = r; });
  const page = await open(agentFixture("lead-scorer"), { runs: [running], timeline: async (_id, o) => (o.after === undefined ? first : ends.then(() => rest)), reread: () => reread(done.run) });
  const latest = () => page.host.querySelector('section[aria-label="Latest run"]')!;
  const row = () => page.host.querySelector('ul[aria-label="Runs"] a')!;
  return { ...page, done, release, latest, row, id: done.run.run_id };
}

const efforts = recorded<{ features: { efforts: string[] } }>("capabilities").body.features.efforts;
/** A start's answer: the run (202), or a recorded refusal thrown as the client throws it. */
type Answer = { run: Run } | { refused: string } | { thrown: { status: number; code: string; message: string; fields?: FieldIssue[] } };
/** Each recorded run's timeline by its run's id: an agent's latest run with one is followed through it. */
const recordedPages = new Map(runNames.map((n) => recorded<TimelinePage>(`${n}.timeline`).body).map((p) => [p.run_id, p]));
/** A final page with no rows, at the run's own status: what a run without a recorded timeline is followed through. */
const endedPage = (r: Run): TimelinePage => ({ cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, run_id: r.run_id, status: r.status, state: r.state, rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
type Opts = { runs?: Run[]; next?: string | null; more?: () => Promise<{ runs: Run[]; next_cursor: string | null }>; tab?: string; answer?: Answer; stats?: () => Promise<unknown>; models?: { default: string; source: string; route_prefix?: string | null }; harnesses?: { id: string; default_model?: string | null; available?: boolean; reason?: string }[]; hold?: Promise<unknown>; strict?: boolean; timeline?: (id: string, o: { after?: number }) => Promise<TimelinePage>; reread?: (id: string) => Promise<Run>; agentError?: unknown; places?: Places | null };
/** By default the server's stats carry the sample analytics. `followed` lists the latest run's reads (its
 *  timeline's pages and its record), apart from the page's own reads in `asked`. */
async function open(agent: Agent, { runs = runsOf("invoice-checker"), next = null, more, tab, answer = { run: recorded<Run>("start.run").body }, stats = async () => statsWith(ANALYTICS), models, harnesses, hold, strict = false, timeline, reread, agentError, places }: Opts = {}) {
  const went: string[] = [];
  const asked: string[] = [];
  const followed: string[] = [];
  const statsAsked: string[] = [];
  const starts: { id: string; body: Record<string, unknown>; key: string }[] = [];
  const v2 = {
    statsOver: async ({ from, agent: of }: { from?: string; agent?: string }) => { statsAsked.push(`stats ${of}${from ? ` from ${from}` : ""}`); return stats(); },
    startRun: async (id: string, body: Record<string, unknown>, key: string) => {
      starts.push({ id, body, key });
      await hold;
      if ("run" in answer) return { run: answer.run, status: 202 };
      if ("thrown" in answer) throw Object.assign(new ClientError(answer.thrown.status, answer.thrown.code, answer.thrown.message), answer.thrown.fields ? { fields: answer.thrown.fields } : {});
      const r = recorded<{ error: { code: string; message: string; fields?: FieldIssue[] } }>(answer.refused);
      throw Object.assign(new ClientError(r.status, r.body.error.code, r.body.error.message), r.body.error.fields ? { fields: r.body.error.fields } : {});
    },
    getAgent: async (id: string) => { asked.push(`agent ${id}`); if (agentError) throw agentError; return { agent, etag: null }; },
    listAgentRuns: async (id: string, _limit: number, cursor?: string | null, archived?: boolean) => {
      asked.push(`runs ${id}${cursor ? ` after ${cursor}` : ""}${archived ? " archived" : ""}`);
      return cursor && more ? more() : { runs, next_cursor: next };
    },
    getTimeline: async (id: string, o: { after?: number } = {}) => {
      followed.push(`timeline ${id}${o.after === undefined ? "" : ` after ${o.after}`}`);
      return timeline ? timeline(id, o) : recordedPages.get(id) ?? endedPage(runs.find((r) => r.run_id === id)!);
    },
    getRun: async (id: string) => { followed.push(`run ${id}`); return reread ? reread(id) : runs.find((r) => r.run_id === id)!; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const props = { v2: v2 as never, agentId: agent.agent_id, defaultModel: models?.default ?? editorCaps.defaultModel, modelSource: models?.source, routePrefix: models?.route_prefix, harnesses, efforts, go: (h: string) => went.push(h), tab, places };
  act(() => root!.render(strict ? createElement(StrictMode, null, createElement(AgentPage, props)) : createElement(AgentPage, props)));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const fact = (name: string) => [...host.querySelectorAll("dt")].find((t) => t.textContent === name)?.nextElementSibling?.textContent;
  const bar = () => host.querySelector('section[aria-label="Start a run"]');
  const input = () => bar()!.querySelector("textarea") as HTMLTextAreaElement;
  const set = async (el: HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  };
  const effort = () => bar()!.querySelector('select[aria-label="Effort"]') as HTMLSelectElement;
  return { host, went, asked, followed, statsAsked, starts, click, button, tabs, fact, bar, input, set, effort };
}

describe("AgentPage", () => {
  it("shows an ended run's known cost and how many charges have no price, and an unknown cost with nothing known not at all", async () => {
    const runs = runsOf("invoice-checker");
    const unknown = { usd: null, basis: "estimate" as const, charge_state: null, cap_usd: null };
    const page = await open(agentFixture("invoice-checker"), { runs: [{ ...runs[0], cost: { ...unknown, so_far_usd: 0.07, unpriced: 1 } }, { ...runs[1], cost: unknown }] });
    const links = [...page.host.querySelectorAll<HTMLAnchorElement>('ul[aria-label="Runs"] a')];
    expect(links[0].textContent).toContain("$0.07 est. known · 1 not priced");
    expect(links[1].textContent).not.toMatch(/\$|Unknown|so far/);
  });

  it("heads the page with the current revision's harness, model and thinking, and Edit opens the editor", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect(page.host.querySelector("h1")?.textContent).toBe("Invoice checker");
    expect(page.fact("Harness")).toBe("pi");
    expect(page.fact("Thinking")).toBe("high");
    // No model of its own: the server's default, named as the default.
    expect(page.fact("Model")).toBe(`${editorCaps.defaultModel} (default)`);
    expect(page.fact("Revision")).toBe("rev 3 of 3");
    expect(page.host.textContent).not.toContain("Archived");
    await page.click(/^Edit$/);
    expect(page.went).toEqual(["#/agents/invoice-checker/edit"]);
  });

  it("says Unattended in its head when the agent never asks, and nothing when it asks", async () => {
    const chip = (host: HTMLElement) => [...host.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "Unattended");
    const a = agentFixture("invoice-checker");
    const page = await open({ ...a, definition: { ...a.definition, approvals: "never" } });
    expect(chip(page.host)).toBeTruthy();
    expect(chip(page.host)!.getAttribute("title")).toContain("never waits for you");
  });
  it("says nothing of approvals for an agent that asks", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect([...page.host.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent === "Unattended")).toBe(false);
  });
  it("names a model the revision sets as it is", async () => {
    const a = agentFixture("invoice-checker");
    const page = await open({ ...a, definition: { ...a.definition, model: "openrouter/some-model" } });
    expect(page.fact("Model")).toBe("openrouter/some-model");
  });

  it("opens on the Runs tab: the agent's runs, each a link to its run, with when, how long and a known cost", async () => {
    const runs = runsOf("invoice-checker");
    // A cost the server does not know is left out, never shown as $0.
    const unknown = { ...runs[runs.length - 1], cost: { usd: null, basis: "estimate" as const, charge_state: null, cap_usd: null } };
    const page = await open(agentFixture("invoice-checker"), { runs: [...runs.slice(0, -1), unknown] });
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker"]);
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    const links = [...page.host.querySelectorAll<HTMLAnchorElement>('ul[aria-label="Runs"] a')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(runs.map((r) => `#/runs/${encodeURIComponent(r.run_id)}`));
    expect(links[0].textContent).toContain(runs[0].title);
    expect(page.host.textContent).toContain(`${runs.length} runs`);
    // An ended run says how long it ran; one still waiting on a person does not.
    const ended = runs.findIndex((r) => r.ended_at);
    const open_ = runs.findIndex((r) => !r.ended_at);
    expect(links[ended].querySelector('[title="How long it ran"]')).toBeTruthy();
    expect(links[open_].querySelector('[title="How long it ran"]')).toBeNull();
    expect(links[1].textContent).toContain("$0.0088 est.");
    expect(links[links.length - 1].textContent).not.toMatch(/\$|Unknown/);
  });

  it("says when the agent has no runs yet, and where its first one will show; nothing is followed", async () => {
    const page = await open(agentFixture("invoice-checker"), { runs: [] });
    expect(page.host.textContent).toContain("No runs of this agent yet.");
    expect(page.host.textContent).toContain("Start one above: its timeline shows here as the agent works.");
    expect(page.host.querySelector('section[aria-label="Latest run"]')).toBeNull();
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
    expect(page.followed).toEqual([]);
  });

  it("opens on the latest run as the run page shows it, above the runs: its status, its timeline and a link to the whole run", async () => {
    const runs = runsOf("invoice-checker");
    const page = await open(agentFixture("invoice-checker"));
    const latest = page.host.querySelector('section[aria-label="Latest run"]')!;
    const list = page.host.querySelector('ul[aria-label="Runs"]')!;
    expect(latest.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(new Set([...latest.querySelectorAll("a")].map((a) => a.getAttribute("href")))).toEqual(new Set([`#/runs/${encodeURIComponent(runs[0].run_id)}`]));
    expect(latest.textContent).toContain(runs[0].title);
    // Its status reads as its row's does (this one ran out of budget), and its recorded timeline is the run page's.
    expect(latest.textContent).toContain("Failed");
    expect(latest.textContent).toContain("Model request failed: spend_cap_reached");
    // An ended run's timeline is read once, never shown as still going, and its record is not read again.
    expect(latest.textContent).not.toContain("Steps appear as the agent takes them.");
    expect(page.followed).toEqual([`timeline ${runs[0].run_id}`]);
  });

  it("follows a running latest run: its timeline grows as the agent works, and its status and row move when it ends", async () => {
    const { done, release, latest, row, id, ...page } = await splitRun();
    // Three rows, two steps: the tool's call and its result are one step.
    expect(latest().querySelectorAll("ol > li")).toHaveLength(2);
    expect(latest().textContent).toContain("Working");
    expect(latest().textContent).toContain("Steps appear as the agent takes them.");
    expect(row().textContent).toContain("Working");
    release();
    await until(() => latest().textContent!.includes("Completed"));
    // Seven rows, five steps now (each tool once, the cost so far at the end): all shown, as on the run page.
    expect(latest().querySelectorAll("ol > li")).toHaveLength(5);
    expect(latest().textContent).not.toContain("earlier steps");
    expect(latest().textContent).toContain(done.page.rows[6].summary);
    expect(latest().textContent).not.toContain("Steps appear as the agent takes them.");
    expect(row().textContent).toContain("Completed");
    expect(page.followed).toEqual([`timeline ${id}`, `timeline ${id} after 3`, `run ${id}`]);
  });

  it("reads an ended run again when the first read fails, though no page follows the last: the badge and row end Completed", async () => {
    let tries = 0;
    const { release, latest, row, id, ...page } = await splitRun(async (done) => { if (++tries === 1) throw new TypeError("Failed to fetch"); return done; });
    release();
    await until(() => latest().textContent!.includes("Completed"));
    expect(row().textContent).toContain("Completed");
    expect(latest().textContent).not.toContain("could not be refreshed");
    expect(page.followed).toEqual([`timeline ${id}`, `timeline ${id} after 3`, `run ${id}`, `run ${id}`]);
  });

  it("a read begun for a status the run has since left never lands: paused, resumed, paused again stays Paused", async () => {
    // A recorded workflow run, paused; its timeline pages say it resumed, then paused again, and the read of the run
    // begun when it resumed answers only after that, with the record as it was while it worked.
    const done = runFixture("run.completed.idle.1");
    const at = (status: Run["status"], state: Run["state"]): Run => ({ ...done.run, status, state, ended_at: null, result: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } });
    const paused = at("paused", "idle");
    const pageOf = (r: Run, n: number): TimelinePage => ({ ...done.page, status: r.status, state: r.state, rows: done.page.rows.slice(0, n), final: false, next_after: n });
    const pages = [pageOf(paused, 1), pageOf(at("working", "working"), 2), pageOf(paused, 3)];
    let answer!: (r: Run) => void;
    const late = new Promise<Run>((r) => { answer = r; });
    const page = await open(agentFixture("lead-scorer"), { runs: [paused], timeline: async () => pages.shift() ?? new Promise<never>(() => {}), reread: () => late });
    const latest = () => page.host.querySelector('section[aria-label="Latest run"]')!;
    const row = () => page.host.querySelector('ul[aria-label="Runs"] a')!;
    // The paused page again has been taken once the next read of the timeline is asked for.
    await until(() => page.followed.filter((r) => r.startsWith("timeline")).length === 4);
    await act(async () => { answer(at("working", "working")); await new Promise((r) => setTimeout(r, 50)); });
    expect(latest().textContent).toContain("Paused");
    expect(latest().textContent).not.toContain("Working");
    expect(row().textContent).toContain("Paused");
    expect(row().textContent).not.toContain("Working");
    const id = done.run.run_id;
    expect(page.followed).toEqual([`timeline ${id}`, `timeline ${id} after 1`, `run ${id}`, `timeline ${id} after 2`, `timeline ${id} after 3`]);
  });

  it("says when an ended run cannot be read again, never showing it as still working, and Retry reads it again", async () => {
    let down = true;
    const { release, latest, row, id, ...page } = await splitRun(async (done) => { if (down) throw new TypeError("Failed to fetch"); return done; });
    release();
    await until(() => latest().textContent!.includes("This run could not be refreshed: Failed to fetch"));
    // Three tries, then the note; the timeline's last page says the run ended, so nothing in the panel says it works.
    expect(page.followed).toEqual([`timeline ${id}`, `timeline ${id} after 3`, `run ${id}`, `run ${id}`, `run ${id}`]);
    expect(latest().textContent).toContain("Not refreshed");
    expect(latest().textContent).not.toContain("Working");
    expect(latest().textContent).not.toContain("Steps appear as the agent takes them.");
    down = false;
    await page.click(/^Retry$/);
    await until(() => latest().textContent!.includes("Completed"));
    expect(latest().textContent).not.toMatch(/could not be refreshed|Not refreshed/);
    expect(row().textContent).toContain("Completed");
    expect(page.followed.filter((r) => r === `run ${id}`)).toHaveLength(4);
  });

  it("reads the next page with Load more, and a failed one keeps the runs already read", async () => {
    const runs = runsOf("invoice-checker");
    let fail = true;
    const page = await open(agentFixture("invoice-checker"), { runs: runs.slice(0, 5), next: "c2", more: async () => {
      if (fail) throw new Error("the network went away");
      return { runs: runs.slice(5), next_cursor: null };
    } });
    const count = () => page.host.querySelectorAll('ul[aria-label="Runs"] a').length;
    expect(count()).toBe(5);
    await page.click(/^Load more$/);
    expect(count()).toBe(5);
    expect(page.host.textContent).toContain("More runs could not be read.");
    expect(page.host.textContent).toContain("the network went away");
    fail = false;
    await page.click(/^Load more$/);
    expect(count()).toBe(runs.length);
    expect(page.button(/^Load more$/)).toBeUndefined();
    expect(page.host.textContent).not.toContain("could not be read");
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker", "runs invoice-checker after c2", "runs invoice-checker after c2"]);
  });

  it("has a Workflow tab only for a workflow agent, at its own address", async () => {
    const page = await open(agentFixture("support-triage"), { runs: runsOf("support-triage") });
    expect(page.tabs()).toEqual(["Runs", "Workflow", "Analytics"]);
    // A workflow revision has no harness, model or thinking of its own.
    expect(page.fact("Harness")).toBeUndefined();
    await page.click(/^Workflow$/);
    expect(page.went).toEqual(["#/agents/support-triage/workflow"]);
  });

  it("draws a workflow agent's graph read-only on its Workflow tab, with a way to the editor", async () => {
    const page = await open(agentFixture("support-triage"), { tab: "workflow" });
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Workflow");
    expect(page.host.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("The workflow's graph");
    const panel = page.host.querySelector('[role="tabpanel"]')!;
    expect(panel.querySelector('svg[role="img"]')).toBeTruthy();
    expect(panel.querySelectorAll("textarea, input, select, [contenteditable]").length).toBe(0);
    await page.click(/Edit the workflow/);
    expect(page.went).toEqual(["#/agents/support-triage/edit"]);
  });

  it("opens an agentic agent on its Runs tab whatever tab the address names", async () => {
    const page = await open(agentFixture("invoice-checker"), { tab: "workflow" });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeTruthy();
  });

  it("shows an archived agent as archived, with its runs, which are archived with it, and goes back to the archived agents", async () => {
    const agent = archivedAgents()[0];
    const runs = runsOf("invoice-checker").slice(0, 2).map((r) => ({ ...r, agent_id: agent.agent_id, archived_at: agent.archived_at }));
    const page = await open(agent, { runs });
    expect([...page.host.querySelectorAll("header span")].some((s) => s.textContent === "Archived")).toBe(true);
    expect(page.asked).toEqual([`agent ${agent.agent_id}`, `runs ${agent.agent_id} archived`]);
    expect(page.host.querySelectorAll('ul[aria-label="Runs"] a').length).toBe(2);
    await page.click(/^Agents$/);
    expect(page.went).toEqual(["#/agents?archived=true"]);
  });

  it("shows an Analytics tab once the server's stats for this agent are read, and none when the read fails", async () => {
    const page = await open(agentFixture("invoice-checker"), { stats: async () => statsWith(ANALYTICS) });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    // One read, bounded: this agent's, over the Analytics tab's first range (from a UTC day 29 days back).
    expect(page.statsAsked).toHaveLength(1);
    expect(page.statsAsked[0]).toMatch(/^stats invoice-checker from \d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    await page.click(/^Analytics$/);
    expect(page.went).toEqual(["#/agents/invoice-checker/analytics"]);
    act(() => root?.unmount());
    // A read that fails: no tab, and nothing in its place.
    const failed = await open(agentFixture("invoice-checker"), { stats: async () => { throw new Error("the store is busy"); } });
    expect(failed.tabs()).toEqual(["Runs"]);
    expect(failed.host.textContent).not.toMatch(/analytics/i);
  });

  it("opens the address's Analytics tab once the stats are read, and Runs when they can't be", async () => {
    let answer!: (v: unknown) => void;
    // The page's read waits; the tab opens on its answer, then reads them again itself (a run may have ended since).
    const page = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: () => new Promise((r) => (answer = r)) });
    // Waiting for the stats: no other tab's content is read meanwhile.
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
    expect(page.asked).toEqual(["agent invoice-checker"]);
    await act(async () => { answer(statsWith(ANALYTICS)); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Analytics");
    expect(page.host.querySelector('[role="radiogroup"][aria-label="Range"]')).toBeTruthy();
    expect(page.host.textContent).toContain("Success by harness and effort");
    expect(page.statsAsked).toHaveLength(2);
    act(() => root?.unmount());
    const failed = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: async () => { throw new Error("the store is busy"); } });
    expect(failed.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    expect(failed.host.querySelector('ul[aria-label="Runs"]')).toBeTruthy();
  });

  it("runs the agent from its page with the picked effort, never an output, and opens the run it started", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect([...page.effort().options].map((o) => o.textContent)).toEqual(["default", ...efforts]);
    await page.set(page.input(), "Check invoice INV-1050.");
    await page.set(page.effort(), "high");
    await page.click(/^Run$/);
    expect(page.starts.map((s) => [s.id, s.body])).toEqual([["invoice-checker", { input: { content: "Check invoice INV-1050." }, effort: "high" }]]);
    expect(page.starts[0].key).toBeTruthy();
    expect(page.went).toEqual([`#/runs/${recorded<Run>("start.run").body.run_id}`]);
  });

  it("sends no effort when the effort is default, so the server's own order applies", async () => {
    const page = await open(agentFixture("invoice-checker"));
    expect(page.effort().value).toBe("");
    await page.set(page.input(), "Check invoice INV-1050.");
    await page.click(/^Run$/);
    expect(page.starts.map((s) => s.body)).toEqual([{ input: { content: "Check invoice INV-1050." } }]);
  });

  it("gives a workflow agent its input as JSON, from its example, and sends it parsed", async () => {
    const a = agentFixture("support-triage");
    const example = recorded<unknown>("start.workflow-run").request as { body?: { input: unknown } };
    const w = a.definition.workflow as { schemas: Record<string, object> };
    const withExample = { ...a, definition: { ...a.definition, workflow: { ...w, schemas: { ...w.schemas, Ticket: { ...w.schemas.Ticket, examples: [example.body!.input] } } } } };
    const page = await open(withExample, { answer: { run: recorded<Run>("start.workflow-run").body } });
    expect(JSON.parse(page.input().value)).toEqual(example.body!.input);
    expect(page.bar()!.textContent).toContain("The workflow's example input.");
    await page.click(/^Run$/);
    expect(page.starts.map((s) => s.body)).toEqual([{ input: example.body!.input }]);
    expect(page.went).toEqual([`#/runs/${recorded<Run>("start.workflow-run").body.run_id}`]);
  });

  it("says when a workflow agent's input is not JSON, and does not send it", async () => {
    const page = await open(agentFixture("support-triage"));
    expect(JSON.parse(page.input().value)).toEqual({ subject: "", body: "" });
    await page.set(page.input(), "{ not json");
    expect(page.bar()!.textContent).toContain("The workflow's input is JSON: this is not.");
    expect(page.button(/^Run$/)!.disabled).toBe(true);
  });

  it("shows a 409 agent_not_runnable inline, stays on the page, and a retry is the same request", async () => {
    const page = await open(agentFixture("invoice-checker"), { answer: { refused: "write.run-on-unavailable-harness" } });
    await page.set(page.input(), "Check the 2.4.1 entry.");
    await page.click(/^Run$/);
    expect(page.bar()!.querySelector('[role="alert"]')?.textContent).toBe("The run did not start: This server does not run codex yet.");
    expect(page.went).toEqual([]);
    await page.click(/^Run$/);
    expect(page.starts.map((s) => s.key)).toEqual([page.starts[0].key, page.starts[0].key]);
  });

  it("shows a 422 inline", async () => {
    const page = await open(agentFixture("support-triage"), { answer: { refused: "start.workflow-run-bad-input" } });
    await page.set(page.input(), '{ "subject": "No body" }');
    await page.click(/^Run$/);
    expect(page.bar()!.querySelector('[role="alert"]')?.textContent).toContain("the workflow does not take this input");
    expect(page.went).toEqual([]);
  });

  it("a refused input (#1926) shows the server's schema path and reason, and each further field under it", async () => {
    const first = "the workflow does not take this input: #/properties/b: must not have fewer than 1 characters";
    const second = "the workflow does not take this input: #/properties/c: must be integer";
    const page = await open(agentFixture("support-triage"), { answer: { thrown: { status: 422, code: "input_invalid", message: first, fields: [{ field: "input at #/properties/b", reason: "invalid", message: first }, { field: "input at #/properties/c", reason: "invalid", message: second }] } } });
    await page.set(page.input(), '{ "a": "hello", "b": "", "c": "x" }');
    await page.click(/^Run$/);
    const alert = page.bar()!.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain(`The run did not start: ${first}`);
    expect([...alert.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`input at #/properties/c: ${second}`]);
    expect(alert.textContent).not.toContain("INPUT_INVALID");
    expect(page.went).toEqual([]);
  });

  it("has no run bar for an archived agent, which takes no runs", async () => {
    const page = await open(archivedAgents()[0], { runs: [] });
    expect(page.bar()).toBeNull();
  });

  it("shows a run's effort on its row when it has one", async () => {
    const runs = runsOf("invoice-checker");
    const page = await open(agentFixture("invoice-checker"), { runs: [{ ...runs[0], effort: "high" }, ...runs.slice(1)] });
    const links = [...page.host.querySelectorAll<HTMLAnchorElement>('ul[aria-label="Runs"] a')];
    expect(links[0].textContent).toContain("effort high");
    expect(links.slice(1).some((a) => a.textContent?.includes("effort"))).toBe(false);
  });

  it("demo: runs the agent at high effort from its page, then lists the run with its effort and shows the agent's analytics", async () => {
    const started = { ...recorded<Run>("start.run").body, effort: "high" as const };
    const page = await open(agentFixture("invoice-checker"), { stats: async () => statsWith(ANALYTICS) });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    await page.set(page.input(), "Check invoice INV-1050.");
    await page.set(page.effort(), "high");
    await page.click(/^Run$/);
    expect(page.starts.map((s) => s.body)).toEqual([{ input: { content: "Check invoice INV-1050." }, effort: "high" }]);
    expect(page.went).toEqual([`#/runs/${started.run_id}`]);
    act(() => root?.unmount());
    // Back on the agent's page: the run is listed with the effort it was started at, and the Analytics tab reads the agent's.
    const back = await open(agentFixture("invoice-checker"), { runs: [started, ...runsOf("invoice-checker")], stats: async () => statsWith(ANALYTICS) });
    const row = back.host.querySelector<HTMLAnchorElement>(`ul[aria-label="Runs"] a[href="#/runs/${encodeURIComponent(started.run_id)}"]`);
    expect(row?.textContent).toContain("effort high");
    await back.click(/^Analytics$/);
    expect(back.went).toEqual(["#/agents/invoice-checker/analytics"]);
    act(() => root?.unmount());
    const analytics = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: async () => statsWith(ANALYTICS) });
    expect(analytics.host.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Analytics");
    // The page's read, over the tab's first range, which the tab opens on, then the tab's own read of the same range.
    expect(analytics.statsAsked).toHaveLength(2);
    for (const asked of analytics.statsAsked) expect(asked).toMatch(/^stats invoice-checker from \d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(analytics.host.textContent).toContain("Success by harness and effort");
  });
  it("a start that answers after the page is gone leaves the person where they went: no navigation", async () => {
    let release!: () => void;
    const page = await open(agentFixture("invoice-checker"), { hold: new Promise<void>((r) => (release = r)) });
    await page.set(page.input(), "Check invoice INV-1050.");
    await act(async () => { page.button(/^Run$/)!.click(); });
    expect(page.starts).toHaveLength(1);
    act(() => root?.unmount());
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(page.went).toEqual([]);
  });

  it("under React's StrictMode (effects run twice), a start still ends: Run comes back and the run opens; the tab adds one read of its own", async () => {
    const page = await open(agentFixture("invoice-checker"), { strict: true });
    await page.set(page.input(), "Check invoice INV-1050.");
    await page.click(/^Run$/);
    expect(page.went).toEqual([`#/runs/${recorded<Run>("start.run").body.run_id}`]);
    expect(page.button(/^Run$/)).toBeTruthy();
    expect(page.button(/^Starting$/)).toBeUndefined();
    act(() => root?.unmount());
    // StrictMode runs the page's own read twice in development; the Analytics tab adds one of its own, not two.
    const runs = await open(agentFixture("invoice-checker"), { strict: true, stats: async () => statsWith(ANALYTICS) });
    const pageReads = runs.statsAsked.length;
    act(() => root?.unmount());
    const tab = await open(agentFixture("invoice-checker"), { strict: true, tab: "analytics", stats: async () => statsWith(ANALYTICS) });
    expect(tab.host.textContent).toContain("Success by harness and effort");
    expect(tab.statsAsked).toHaveLength(pageReads + 1);
  });

  it("opening the page, then its Analytics tab, reads the agent's stats again when the tab opens (a run may have ended since)", async () => {
    let reads = 0;
    const page = await open(agentFixture("invoice-checker"), { stats: async () => { reads++; return statsWith(ANALYTICS); } });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    act(() => root?.unmount());
    // The tab's address, as the click goes there: the page reads once, and the tab reads again as it opens.
    const tab = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: async () => { reads++; return statsWith(ANALYTICS); } });
    expect(tab.host.textContent).toContain("Success by harness and effort");
    expect(tab.statsAsked).toHaveLength(2);
    expect(reads).toBe(3);
  });
});

describe("AgentPage, the model on a gateway server", () => {
  const gateway = { default: "agent-model/gpt-6-luna", source: "gateway", route_prefix: "agent-model" };
  const on = (harness: string, model?: string): Agent => {
    const a = agentFixture("invoice-checker");
    const { model: _m, ...definition } = a.definition;
    return { ...a, definition: { ...definition, harness, ...(model ? { model } : {}) } };
  };
  const modelOf = (page: Awaited<ReturnType<typeof open>>) => [...page.host.querySelectorAll("dt")].find((t) => t.textContent === "Model")!.nextElementSibling as HTMLElement;
  it("shows the default without the gateway's routing prefix, the full id in its title", async () => {
    const page = await open(on("pi"), { models: gateway });
    expect(modelOf(page).textContent).toBe("gpt-6-luna (default)");
    expect(modelOf(page).title).toBe("agent-model/gpt-6-luna");
  });
  it("with each harness's default named by the server, a codex agent shows the gateway's default", async () => {
    const harnesses = [{ id: "pi", default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", default_model: null }, { id: "codex", default_model: "agent-model/gpt-6-luna" }];
    const page = await open(on("codex"), { models: gateway, harnesses });
    expect(modelOf(page).textContent).toBe("gpt-6-luna (default)");
    const claude = await open(on("claude-agent"), { models: gateway, harnesses });
    expect(modelOf(claude).textContent).toBe("none yet: add a model key in Settings → Model keys");
  });
  it("a claude-agent agent naming no model has no default to show", async () => {
    const page = await open(on("claude-agent"), { models: gateway });
    expect(modelOf(page).textContent).toBe("none yet: add a model key in Settings → Model keys");
    expect(page.host.textContent).not.toContain("gpt-6-luna");
  });
});

// A harness the server can't run says why on the agent's page, where its Run would fail: the reason the server gives
// (capabilities' harnesses[].reason), and a Run that does not send.
describe("AgentPage, an agent whose harness the server can't run", () => {
  const on = (harness: string): Agent => {
    const a = agentFixture("invoice-checker");
    return { ...a, definition: { ...a.definition, harness } };
  };
  const harnesses = [{ id: "pi", available: true }, { id: "claude-agent", available: false, reason: "claude-agent needs ANTHROPIC_API_KEY." }, { id: "codex", available: false }];

  it("says why, in place of a run that would fail, and its Run sends nothing", async () => {
    const page = await open(on("claude-agent"), { harnesses });
    const why = page.host.querySelector('[aria-label="Harness not available"]');
    expect(why?.textContent).toBe("claude-agent doesn't run on this server: claude-agent needs ANTHROPIC_API_KEY.");
    await page.set(page.input(), "Check this invoice.");
    const run = page.button(/^Run$/)!;
    expect(run.disabled).toBe(true);
    await page.click(/^Run$/);
    // Ctrl or Cmd with Enter in the message starts a run without the button: the guard holds there too.
    for (const key of [{ ctrlKey: true }, { metaKey: true }]) {
      await act(async () => { page.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...key })); });
    }
    expect(page.starts).toEqual([]);
  });

  it("names the harness when the server gives no reason, and says nothing for a harness that runs", async () => {
    const codex = await open(on("codex"), { harnesses });
    expect(codex.host.querySelector('[aria-label="Harness not available"]')?.textContent).toBe("codex doesn't run on this server.");
    act(() => root!.unmount()); root = undefined;
    const pi = await open(on("pi"), { harnesses });
    expect(pi.host.querySelector('[aria-label="Harness not available"]')).toBeNull();
    await pi.set(pi.input(), "Check this invoice.");
    expect(pi.button(/^Run$/)!.disabled).toBe(false);
  });
});

// Where the agent runs, said with the rest of its current revision: its box, the server, or, with no place, the server's
// default place (default_place, resolved at each run).
describe("AgentPage, where it runs", () => {
  it("says the box an agent runs in, the server, or the server's default place", async () => {
    const base = agentFixture("invoice-checker");
    const boxed = { ...base, definition: { ...base.definition, place: { mode: "sandbox", box: "docker" } } };
    expect((await open(boxed)).fact("Runs")).toBe("In a docker box");
    act(() => root?.unmount()); document.body.innerHTML = "";
    act(() => root?.unmount()); document.body.innerHTML = "";
    const runner = { ...base, definition: { ...base.definition, place: { mode: "runner" } } };
    expect((await open(runner)).fact("Runs")).toBe("On the server");
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect((await open(base)).fact("Runs")).toBe("Where this server's default place is");
  });
  // A revision that names no place runs where the server resolves it at each run (#1790): default_place, or the runner for
  // one with a runner-only tool. The page names that place, marked as the server's default; a named place is never marked.
  const PLACES = (defaultPlace: Places["defaultPlace"]): Places => ({ modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }], defaultPlace });
  it("names the server's default place for an agent that names none, and marks it as the default", async () => {
    const base = agentFixture("invoice-checker");
    expect((await open(base, { places: PLACES({ mode: "sandbox", box: "docker" }) })).fact("Runs")).toBe("In a docker box (server default)");
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect((await open(base, { places: PLACES({ mode: "runner" }) })).fact("Runs")).toBe("On the server (server default)");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const browser = { ...base, definition: { ...base.definition, tools: ["browser"] } };
    expect((await open(browser, { places: PLACES({ mode: "sandbox", box: "docker" }) })).fact("Runs")).toBe("On the server (server default)");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const runner = { ...base, definition: { ...base.definition, place: { mode: "runner" } } };
    expect((await open(runner, { places: PLACES({ mode: "sandbox", box: "docker" }) })).fact("Runs")).toBe("On the server");
  });
});

// Each failed read says what failed and what to do next in words: an agent this server has no record of, a server that
// can't be reached, and anything else thrown, with what was said kept small.
describe("AgentPage, a failed read's problem", () => {
  it("says the agent's read failing: a refusal, an error and anything else thrown", async () => {
    const refused = await open(agentFixture("invoice-checker"), { agentError: new ClientError(404, "agent_not_found", "no agent invoice-checker") });
    const r = refused.host.querySelector('[role="alert"]')!;
    expect(r.textContent).toContain("No agent with this id.");
    expect(r.querySelector('a[href="#/agents"]')?.textContent).toBe("Open the agents list");
    act(() => root?.unmount());
    const failed = await open(agentFixture("invoice-checker"), { agentError: new TypeError("Failed to fetch") });
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("The agent could not be read.Can't reach agentrun-serve.");
    expect(failed.host.querySelector('[role="alert"]')?.textContent).not.toContain("TypeError");
    act(() => root?.unmount());
    const thrown = await open(agentFixture("invoice-checker"), { agentError: "offline" });
    expect(thrown.host.querySelector('[role="alert"]')?.textContent).toContain("Something went wrong in the console. Reload the page.");
    expect(thrown.host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  });

  it("says the next page of runs refused", async () => {
    const runs = runsOf("invoice-checker");
    const page = await open(agentFixture("invoice-checker"), { runs: runs.slice(0, 5), next: "c2", more: async () => { throw new ClientError(400, "invalid_cursor", "that cursor is not one this server gave"); } });
    await page.click(/^Load more$/);
    expect(page.host.textContent).toContain("More runs could not be read.");
    expect(page.host.textContent).toContain("that cursor is not one this server gave · invalid_cursor");
  });

  it("says the latest run's record refused on every try, and its timeline refused", async () => {
    const { release, latest } = await splitRun(async () => { throw new ClientError(503, "store_busy", "the store is busy", true); });
    release();
    await until(() => latest().textContent!.includes("This run could not be refreshed: store_busy: the store is busy"));
    act(() => root?.unmount());
    const page = await open(agentFixture("invoice-checker"), { timeline: async () => { throw new ClientError(404, "run_not_found", "no run with that id"); } });
    const panel = () => page.host.querySelector('section[aria-label="Latest run"]')!;
    await until(() => panel().textContent!.includes("The timeline could not be read: run_not_found: no run with that id"));
  });
});
