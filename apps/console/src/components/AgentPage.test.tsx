import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, archivedAgents, editorCaps, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { ClientError, type FieldIssue } from "@/lib/client";
import { ANALYTICS, statsWith } from "./AgentAnalytics.sample";
import type { Run } from "@/lib/v2";

// An agent's own page: its current revision's settings in the header, its runs, and a workflow agent's graph, read-only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runsOf = (slug: string) => recorded<{ runs: Run[] }>(`agent.${slug}.runs`).body.runs;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const efforts = recorded<{ features: { efforts: string[] } }>("capabilities").body.features.efforts;
/** A start's answer: the run (202), or a recorded refusal thrown as the client throws it. */
type Answer = { run: Run } | { refused: string };
type Opts = { runs?: Run[]; next?: string | null; more?: () => Promise<{ runs: Run[]; next_cursor: string | null }>; tab?: string; answer?: Answer; stats?: () => Promise<unknown> };
/** By default the server's stats carry no analytics, as an older server's. */
async function open(agent: Agent, { runs = runsOf("invoice-checker"), next = null, more, tab, answer = { run: recorded<Run>("start.run").body }, stats = async () => ({}) }: Opts = {}) {
  const went: string[] = [];
  const asked: string[] = [];
  const statsAsked: string[] = [];
  const starts: { id: string; body: Record<string, unknown>; key: string }[] = [];
  const v2 = {
    statsOver: async ({ from, agent: of }: { from?: string; agent?: string }) => { statsAsked.push(`stats ${of}${from ? ` from ${from}` : ""}`); return stats(); },
    startRun: async (id: string, body: Record<string, unknown>, key: string) => {
      starts.push({ id, body, key });
      if ("run" in answer) return { run: answer.run, status: 202 };
      const r = recorded<{ error: { code: string; message: string; fields?: FieldIssue[] } }>(answer.refused);
      throw Object.assign(new ClientError(r.status, r.body.error.code, r.body.error.message), r.body.error.fields ? { fields: r.body.error.fields } : {});
    },
    getAgent: async (id: string) => { asked.push(`agent ${id}`); return { agent, etag: null }; },
    listAgentRuns: async (id: string, _limit: number, cursor?: string | null, archived?: boolean) => {
      asked.push(`runs ${id}${cursor ? ` after ${cursor}` : ""}${archived ? " archived" : ""}`);
      return cursor && more ? more() : { runs, next_cursor: next };
    },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, defaultModel: editorCaps.defaultModel, efforts, go: (h: string) => went.push(h), tab })));
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
  return { host, went, asked, statsAsked, starts, click, button, tabs, fact, bar, input, set, effort };
}

describe("AgentPage", () => {
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

  it("names a model the revision sets as it is", async () => {
    const a = agentFixture("invoice-checker");
    const page = await open({ ...a, definition: { ...a.definition, model: "openrouter/some-model" } });
    expect(page.fact("Model")).toBe("openrouter/some-model");
  });

  it("opens on the Runs tab: the agent's runs, each a link to its run, with when, how long and a known cost", async () => {
    const runs = runsOf("invoice-checker");
    // A cost the server does not know is left out, never shown as $0.
    const unknown = { ...runs[runs.length - 1], cost: null };
    const page = await open(agentFixture("invoice-checker"), { runs: [...runs.slice(0, -1), unknown] });
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker"]);
    expect(page.tabs()).toEqual(["Runs"]);
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

  it("says when the agent has no runs yet", async () => {
    const page = await open(agentFixture("invoice-checker"), { runs: [] });
    expect(page.host.textContent).toContain("No runs of this agent yet.");
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
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
    expect(page.host.textContent).toContain("More runs could not be read: the network went away");
    fail = false;
    await page.click(/^Load more$/);
    expect(count()).toBe(runs.length);
    expect(page.button(/^Load more$/)).toBeUndefined();
    expect(page.host.textContent).not.toContain("could not be read");
    expect(page.asked).toEqual(["agent invoice-checker", "runs invoice-checker", "runs invoice-checker after c2", "runs invoice-checker after c2"]);
  });

  it("has a Workflow tab only for a workflow agent, at its own address", async () => {
    const page = await open(agentFixture("support-triage"), { runs: runsOf("support-triage") });
    expect(page.tabs()).toEqual(["Runs", "Workflow"]);
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
    expect(page.tabs()).toEqual(["Runs"]);
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

  it("shows an Analytics tab only when the server's stats for this agent carry analytics", async () => {
    const page = await open(agentFixture("invoice-checker"), { stats: async () => statsWith(ANALYTICS) });
    expect(page.tabs()).toEqual(["Runs", "Analytics"]);
    expect(page.statsAsked).toEqual(["stats invoice-checker"]);
    await page.click(/^Analytics$/);
    expect(page.went).toEqual(["#/agents/invoice-checker/analytics"]);
    act(() => root?.unmount());
    // An older server's stats have no analytics, and one without stats fails them: no tab, and nothing in its place.
    for (const stats of [async () => statsWith(), async () => { throw new Error("no route GET /v2/stats"); }]) {
      const older = await open(agentFixture("invoice-checker"), { stats });
      expect(older.tabs()).toEqual(["Runs"]);
      expect(older.host.textContent).not.toMatch(/analytics/i);
      act(() => root?.unmount());
    }
  });

  it("opens the address's Analytics tab once the stats say it is there, and Runs on a server without it", async () => {
    let answer!: (v: unknown) => void;
    let calls = 0;
    // The page's read waits; the tab's own read, once it opens, answers at once.
    const page = await open(agentFixture("invoice-checker"), { tab: "analytics", stats: () => (++calls === 1 ? new Promise((r) => (answer = r)) : Promise.resolve(statsWith(ANALYTICS))) });
    // Waiting for the stats: no other tab's content is read meanwhile.
    expect(page.host.querySelector('ul[aria-label="Runs"]')).toBeNull();
    expect(page.asked).toEqual(["agent invoice-checker"]);
    await act(async () => { answer(statsWith(ANALYTICS)); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(page.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Analytics");
    expect(page.host.querySelector('[role="radiogroup"][aria-label="Range"]')).toBeTruthy();
    expect(page.host.textContent).toContain("Success by harness and effort");
    act(() => root?.unmount());
    const older = await open(agentFixture("invoice-checker"), { tab: "analytics" });
    expect(older.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Runs");
    expect(older.host.querySelector('ul[aria-label="Runs"]')).toBeTruthy();
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
    const started = { ...recorded<Run>("start.run").body, effort: "high" };
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
    // The page's read, then the tab's: this agent's, from the start of a UTC day 29 days back.
    expect(analytics.statsAsked[0]).toBe("stats invoice-checker");
    expect(analytics.statsAsked[1]).toMatch(/^stats invoice-checker from \d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(analytics.host.textContent).toContain("Success by harness and effort");
  });
});
