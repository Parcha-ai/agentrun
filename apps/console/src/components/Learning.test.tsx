import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningTab, type LearningProps } from "./Learning";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { ClientError } from "@/lib/client";
import type { AgentLearning, Corrections, LearnedItem, LearningFile } from "@/lib/learning";
import { BILL, EMPTY_BILL, hour, TAKEOVER } from "@/lib/learningBill.fixture";
import type { AuditRow, LearningCost, LearningLoop, Promotions, Run } from "@/lib/v2";

// The agent's Learning tab: its owner's corrections (corrections.md, edited whole on its version), the workflow drafts
// its runs compiled (approved, retired and restored on their README's version), what runs did not keep and why, the
// before and after, the loop, and the switch.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (learning?: boolean, extra: Partial<Agent["definition"]> = {}): Agent => ({
  ...SERVED_AGENT, agent_id: "refunds", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Refund policy finder", instructions: "Find it.", harness: "pi", skills: [], tools: ["read", "write"], ...(learning === undefined ? {} : { learning }), ...extra },
});
const TEXT = "# Learned\n\n- Open /policies/refund-policy before anything else.\n- Keep the answer to three lines.\n";
const DRAFT_FILE = "workflows/check-refunds/workflow.json";
const README_FILE = "workflows/check-refunds/README.md";
const flow = (status: LearnedItem["status"] = "serving", extra: Partial<LearnedItem> = {}): LearnedItem => ({ name: "check-refunds", file: DRAFT_FILE, readme: README_FILE, description: "Checks a store's refund window", status, run: "run-a", bytes: 640, etag: '"readme-v1"', ...extra });
const view = (extra: Partial<AgentLearning> = {}): AgentLearning => ({
  agent: "refunds", main: "c3", corrections: TEXT, workflows: [],
  log: { items: [{ by: { run: "run-a" }, commit: "c1", at: "2026-11-03T16:52:10Z", reason: "A correction from a grade.", files: ["corrections.md"] }], total: 1, next_cursor: null },
  counts: { merged: 2, dropped: { empty: 2, checker: 1 }, in_progress: 0 }, impact: null,
  ...extra,
});
const none = () => view({ corrections: "", workflows: [] });
const runOf = (id: string, title: string, learning: Run["learning"]): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: id, agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-03T16:52:00Z", ended_at: "2026-11-03T16:52:09Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning,
});
const RUNS: Run[] = [
  runOf("run-e", "everlane.com", { detail: null, at: "2026-11-03T16:52:09Z", state: "dropped", reason: "empty" }),
  runOf("run-k", "kith.com", { at: "2026-11-03T16:52:09Z", state: "dropped", reason: "checker", detail: "Not kept: the draft did not pass the checks." }),
  runOf("run-c", "allbirds.com", { detail: null, at: "2026-11-03T16:52:09Z", state: "dropped", reason: "empty" }),
  runOf("run-b", "brooklinen.com", { detail: null, at: "2026-11-03T16:52:09Z", state: "merged", reason: null }),
  runOf("run-p", "patagonia.com", { detail: null, at: "2026-11-03T16:52:09Z", state: "dropped", reason: "no_budget" }),
  runOf("run-a", "taylorstitch.com", { detail: null, at: "2026-11-03T16:52:09Z", state: "merged", reason: null }),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

type Fake = {
  learning?: () => Promise<AgentLearning>; runs?: Run[]; caps?: unknown;
  corrections?: () => Promise<Corrections>; write?: (text: string, etag: string) => Promise<Corrections>;
  read?: (file: string) => Promise<LearningFile>; retire?: (file: string, etag: string) => Promise<unknown>; approve?: (file: string, etag: string) => Promise<unknown>; restore?: (file: string, etag: string) => Promise<unknown>;
  update?: (body: unknown, etag: string | null) => Promise<{ agent: Agent; etag: string }>;
  promotions?: () => Promise<Promotions>; loop?: () => Promise<LearningLoop>; cost?: () => Promise<LearningCost>; audits?: AuditRow[];
};
async function open(a: Agent, fake: Fake = {}, props: Partial<LearningProps> = {}) {
  const calls: string[] = [];
  const agents: Agent[] = [];
  const v2 = {
    agentLearning: async (id: string) => { calls.push(`learning ${id}`); return (fake.learning ?? (async () => view()))(); },
    listAgentRuns: async (id: string) => { calls.push(`runs ${id}`); return { runs: fake.runs ?? RUNS, next_cursor: null }; },
    corrections: async () => { calls.push("corrections"); return (fake.corrections ?? (async () => ({ text: TEXT, etag: '"c-v1"', cap_bytes: 2048 })))(); },
    writeCorrections: async (_id: string, text: string, etag: string) => { calls.push(`write ${etag} ${JSON.stringify(text)}`); return (fake.write ?? (async () => ({ text, etag: '"c-v2"', cap_bytes: 2048 })))(text, etag); },
    readLearningFile: async (_id: string, file: string) => { calls.push(`read ${file}`); return (fake.read ?? (async () => ({ text: '{"v": 2, "name": "check-refunds"}\n', etag: `"v-${file}"` })))(file); },
    retireWorkflow: async (_id: string, file: string, etag: string) => { calls.push(`retire ${file} ${etag}`); return (fake.retire ?? (async () => ({ text: "", etag: '"v3"' })))(file, etag); },
    approveWorkflow: async (_id: string, file: string, etag: string) => { calls.push(`approve ${file} ${etag}`); return (fake.approve ?? (async () => ({ text: "", etag: '"v4"' })))(file, etag); },
    restoreWorkflow: async (_id: string, file: string, etag: string) => { calls.push(`restore ${file} ${etag}`); return (fake.restore ?? (async () => ({ text: "", etag: '"v5"' })))(file, etag); },
    getAgent: async () => { calls.push("agent"); return { agent: a, etag: '"rv1"' }; },
    updateDefinition: async (_id: string, body: unknown, etag: string | null) => { calls.push(`put ${JSON.stringify(body)} ${etag}`); return (fake.update ?? (async () => ({ agent: { ...a, revision: "rv2", revisions: 2, definition: { ...a.definition, ...(body as { definition: object }).definition } }, etag: '"rv2"' })))(body, etag); },
    capabilities: async () => { calls.push("capabilities"); return fake.caps ?? {}; },
    // The cost per run chart's read (CostPerRun.test.tsx draws it): no run yet.
    learnedWorkflowRevisions: async (_id: string, name: string) => ({ name, revisions: [], total: 0, truncated: false }),
    learningCost: async () => (fake.cost ?? (async () => ({ agent: a.agent_id, runs: [], total_runs: 0, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [] })))(),
    // The loop's reads: none yet unless a test gives them; a failed one leaves its part out.
    learningPromotions: async () => (fake.promotions ?? (async () => ({ agent: a.agent_id, promotions: [], serving: [] })))(),
    learningLoop: async () => (fake.loop ?? (async () => ({ agent: a.agent_id, completed_runs: 0, compiles: [] })))(),
    learningAudits: async () => ({ agent: a.agent_id, audits: fake.audits ?? [] }),
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(LearningTab, { agent: a, v2: v2 as never, onAgent: (x: Agent) => agents.push(x), ...props })));
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { const b = button(label); expect(b, String(label)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const card = (name: string) => host.querySelector(`article[aria-label="${name}"]`) as HTMLElement | null;
  const type = async (el: Element, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const key = async (el: Element, k: string, mod: { ctrlKey?: boolean; metaKey?: boolean } = {}) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mod })); }); await settle(); };
  const render = async (next: Agent) => {
    act(() => root!.render(createElement(LearningTab, { agent: next, v2: v2 as never, onAgent: (x: Agent) => agents.push(x), ...props })));
    await settle();
  };
  const editor = () => host.querySelector('section[aria-label="Edit corrections"]') as HTMLElement | null;
  return { host, calls, agents, button, click, card, type, key, render, editor, text: () => host.textContent ?? "" };
}
const focus = async () => { await act(async () => { window.dispatchEvent(new Event("focus")); }); await settle(); };

describe("learning model setup", () => {
  it("shows the missing learning route and clears setup after it is configured, without changing learning", async () => {
    let current = view({ learning_model: { location: "server", ready: false, model: "openrouter/example-model", needs: "key", reason: "Add OPENROUTER_API_KEY for this model." } });
    const t = await open(agent(true), { learning: async () => current });
    expect(t.host.querySelector('[aria-label="Learning model setup"]')).not.toBeNull();
    expect(t.text()).toContain("openrouter/example-model");
    expect(t.host.querySelector('a[href="#/settings/keys"]')).not.toBeNull();
    current = view({ learning_model: { ...current.learning_model!, ready: true, needs: null, reason: null } });
    await t.click(/^Refresh learning$/);
    expect(t.host.querySelector('[aria-label="Learning model setup"]')).toBeNull();
    expect(t.text()).toContain("openrouter/example-model");
    expect(t.calls.filter((call) => /^(put |write )/.test(call))).toEqual([]);
  });
});

describe("refreshing learning after external work", () => {
  it("reads the corrections, the workflows and the runs again when returning to the window", async () => {
    let current = view();
    const fake: Fake = { learning: async () => current, runs: [] };
    const t = await open(agent(true), fake);
    current = view({ corrections: "# Learned\n\n- A newly given correction.\n", workflows: [flow()] });
    fake.runs = [runOf("new-run", "External task", { state: "dropped", reason: "checker", detail: "This draft was refused.", at: "2026-11-04T00:00:00Z" })];
    await focus();
    expect(t.text()).toContain("A newly given correction.");
    expect(t.text()).not.toContain("Keep the answer to three lines.");
    expect(t.card("check-refunds")).not.toBeNull();
    expect(t.text()).toContain("This draft was refused.");
    expect(t.calls.filter((call) => call === "learning refunds")).toHaveLength(2);
  });

  it.each(["edit", "retire"])("keeps an open %s intact even when an earlier background reply arrives", async (action) => {
    let release!: (result: AgentLearning) => void;
    let reads = 0;
    const t = await open(agent(true), { learning: () => ++reads === 1 ? Promise.resolve(view({ workflows: [flow()] })) : new Promise((resolve) => { release = resolve; }) });
    await focus();
    expect(reads).toBe(2);
    if (action === "edit") await t.click(/^Edit corrections$/);
    else await t.click(/^Retire check-refunds$/);
    const selector = action === "retire" ? '[role="alertdialog"]' : 'section[aria-label="Edit corrections"]';
    const held = t.host.querySelector(selector)!;
    expect(held).not.toBeNull();
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(true);
    const draft = held.querySelector("textarea");
    if (draft) await t.type(draft, "Keep this unsaved draft.");
    await act(async () => { release(none()); });
    await settle();
    expect(t.host.querySelector(selector)).toBe(held);
    if (draft) expect(draft.value).toBe("Keep this unsaved draft.");
    await focus();
    expect(reads).toBe(2);
    if (action === "retire") await t.key(held, "Escape");
    else await t.click(/^Cancel$/);
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(false);
    await focus();
    expect(reads).toBe(3);
    await act(async () => { release(none()); });
    await settle();
    expect(t.text()).toContain("Nothing learned yet.");
  });

  it("applies a successful retire's own refresh while the retiring confirmation still holds its card", async () => {
    let release!: (result: AgentLearning) => void;
    let reads = 0;
    const t = await open(agent(true), { learning: () => ++reads === 1 ? Promise.resolve(view({ workflows: [flow()] })) : new Promise(resolve => { release = resolve; }) });
    await t.click(/^Retire check-refunds$/);
    await t.click(/^Yes, retire$/);
    expect(reads).toBe(2);
    expect(t.calls.filter(c => c.startsWith("retire "))).toEqual([`retire ${README_FILE} "readme-v1"`]);
    expect(t.host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(true);
    await act(async () => { release(view({ workflows: [flow("retired")] })); });
    await settle();
    expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(t.text()).toContain("No workflow is in use: the next run gets none.");
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(false);
  });

  it("keeps a restore confirmation on its reviewed version while a background reply arrives", async () => {
    let release!: (result: AgentLearning) => void;
    let reads = 0;
    const retired = view({ corrections: "", workflows: [flow("retired", { etag: '"old-v1"' })] });
    const t = await open(agent(true), { learning: () => ++reads === 1 ? Promise.resolve(retired) : reads === 2 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(none()) });
    await focus();
    await t.click(/^Earlier workflows/);
    await t.click(/^Restore check-refunds$/);
    const confirm = t.host.querySelector('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(true);
    await act(async () => { release(none()); }); await settle();
    expect(t.host.querySelector('[role="alertdialog"]')).toBe(confirm);
    await focus();
    expect(reads).toBe(2);
    await t.key(confirm, "Escape");
    expect(t.button(/^Refresh learning$/)?.disabled).toBe(false);
    await focus();
    expect(reads).toBe(3);
    expect(t.text()).toContain("Nothing learned yet.");
  });

  it("keeps an approval in progress until its own refresh completes", async () => {
    let releaseRead!: (result: AgentLearning) => void;
    let releaseApproval!: (result: unknown) => void;
    let reads = 0;
    const waiting = view({ workflows: [flow("pending")] });
    const t = await open(agent(true), { learning: () => ++reads === 1 ? Promise.resolve(waiting) : new Promise((resolve) => { releaseRead = resolve; }), caps: { learning: { pending: true, approve: true } }, approve: () => new Promise((resolve) => { releaseApproval = resolve; }) });
    await focus();
    await t.click(/^Approve check-refunds$/);
    await act(async () => { releaseRead(none()); });
    await settle();
    expect(t.button(/^Approve check-refunds$/)?.textContent).toBe("Approving");
    await focus();
    expect(reads).toBe(2);
    await act(async () => { releaseApproval({}); });
    await settle();
    expect(reads).toBe(3);
    await act(async () => { releaseRead(none()); });
    await settle();
    expect(t.text()).toContain("Nothing learned yet.");
  });

  it("resumes refreshing after an immediately refused approval", async () => {
    let reads = 0;
    const t = await open(agent(true), { learning: async () => ++reads === 1 ? view({ workflows: [flow("pending")] }) : none(), caps: { learning: { pending: true, approve: true } }, approve: async () => { throw new ClientError(412, "precondition_failed", "Changed elsewhere."); } });
    await t.click(/^Approve check-refunds$/);
    expect(t.button(/^Approve check-refunds$/)?.disabled).toBe(false);
    await focus();
    expect(reads).toBe(2);
    expect(t.text()).toContain("Nothing learned yet.");
  });

  it("polls only while visible and removes the timer and listeners on unmount", async () => {
    let tick!: () => void;
    const interval = vi.spyOn(window, "setInterval").mockImplementation((callback) => { tick = callback as () => void; return 123 as unknown as ReturnType<typeof window.setInterval>; });
    const clear = vi.spyOn(window, "clearInterval");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const t = await open(agent(true));
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 15_000);
    await act(async () => { tick(); }); await settle();
    expect(t.calls.filter((call) => call === "learning refunds")).toHaveLength(2);
    hidden.mockReturnValue(true);
    await act(async () => { tick(); window.dispatchEvent(new Event("focus")); }); await settle();
    expect(t.calls.filter((call) => call === "learning refunds")).toHaveLength(2);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await settle();
    expect(t.calls.filter((call) => call === "learning refunds")).toHaveLength(3);
    act(() => root!.unmount()); root = undefined;
    expect(clear).toHaveBeenCalledWith(123);
    await focus();
    expect(t.calls.filter((call) => call === "learning refunds")).toHaveLength(3);
  });

  it("reads the cost (the bill's) again with each refresh, timed or manual, and once on open", async () => {
    let tick!: () => void;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => { tick = callback as () => void; return 123 as unknown as ReturnType<typeof window.setInterval>; });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let costs = 0;
    const cost = async (): Promise<LearningCost> => { costs += 1; return { agent: "refunds", runs: [], total_runs: 0, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [] } as unknown as LearningCost; };
    const t = await open(agent(true), { cost });
    expect(costs).toBe(1);
    await act(async () => { tick(); }); await settle();
    expect(costs).toBe(2);
    await t.click(/^Refresh learning$/);
    expect(costs).toBe(3);
  });

  it("clears the prior agent's open edit and ignores its background replies after navigation", async () => {
    let release!: (result: AgentLearning) => void;
    let reads = 0;
    const newer = view({ agent: "invoices", corrections: "# Learned\n\n- Check invoice totals.\n" });
    const t = await open(agent(true), { learning: () => ++reads === 1 ? Promise.resolve(view()) : reads === 2 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(newer) });
    await focus();
    await t.click(/^Edit corrections$/);
    await t.render({ ...agent(true), agent_id: "invoices" });
    expect(t.editor()).toBeNull();
    expect(t.text()).toContain("Check invoice totals.");
    await act(async () => { release(view()); }); await settle();
    expect(t.text()).toContain("Check invoice totals.");
    expect(t.text()).not.toContain("Keep the answer to three lines.");
  });
});

describe("the corrections", () => {
  it("shows corrections.md as it is on main, counted by its lines, rendered, its HTML kept as text", async () => {
    const t = await open(agent(true), { learning: async () => view({ corrections: `${TEXT}- Quote "Customer: <name>" and $<amount> as written.\n- Never run <script>alert(1)</script>.\n` }) });
    const section = t.host.querySelector('section[aria-label="Corrections"]')!;
    expect(section.textContent).toContain("4 corrections. Every later run is given them whole before it starts.");
    expect(section.querySelectorAll("li")).toHaveLength(4);
    expect(section.textContent).toContain('Quote "Customer: <name>" and $<amount> as written.');
    expect(section.querySelector("script")).toBeNull();
    expect(t.host.querySelector('[data-testid="stage-corrections"]')!.textContent).toContain("4 corrections");
  });

  it("a saved file of headings only is shown as it is, never None yet: every later run is given it", async () => {
    const t = await open(agent(true), { learning: async () => view({ corrections: "# Always answer in Spanish\n" }) });
    const section = t.host.querySelector('section[aria-label="Corrections"]')!;
    expect(section.textContent).not.toContain("None yet");
    expect(section.textContent).toContain("Every later run is given this text whole before it starts.");
    expect(section.querySelector("h1")?.textContent).toBe("Always answer in Spanish");
  });

  it("one correction is said as one: it, not them", async () => {
    const t = await open(agent(true), { learning: async () => view({ corrections: "# Learned\n\n- Only this one.\n" }) });
    expect(t.text()).toContain("1 correction. Every later run is given it whole before it starts.");
  });

  it("Edit reads the file with its version and cap, and Ctrl+Enter saves it whole on that version, then reads the tab again", async () => {
    const changed = vi.fn();
    const t = await open(agent(true), {}, { onChanged: changed });
    await t.click(/^Edit corrections$/);
    expect(t.calls).toContain("corrections");
    const body = t.editor()!.querySelector("textarea")!;
    expect(body.value).toBe(TEXT);
    expect(t.editor()!.textContent).toContain(`${new TextEncoder().encode(TEXT).length} of 2048 bytes`);
    await t.type(body, `${TEXT}- Prices in the shop's currency.\n`);
    await t.key(body, "Enter", { ctrlKey: true });
    expect(t.calls).toContain(`write "c-v1" ${JSON.stringify(`${TEXT}- Prices in the shop's currency.\n`)}`);
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(t.editor()).toBeNull();
    expect(t.host.querySelector('section[aria-label="Corrections"]')!.textContent).toContain("Saved");
  });

  it("Esc and Cancel close it with no write", async () => {
    const t = await open(agent(true));
    await t.click(/^Edit corrections$/);
    await t.key(t.editor()!.querySelector("textarea")!, "Escape");
    expect(t.editor()).toBeNull();
    await t.click(/^Edit corrections$/);
    await t.click(/^Cancel$/);
    expect(t.editor()).toBeNull();
    expect(t.calls.some((c) => c.startsWith("write"))).toBe(false);
  });

  it("past its cap it says so and sends nothing: Save is off and Ctrl+Enter writes nothing", async () => {
    const t = await open(agent(true), { corrections: async () => ({ text: TEXT, etag: '"c-v1"', cap_bytes: 120 }) });
    await t.click(/^Edit corrections$/);
    const body = t.editor()!.querySelector("textarea")!;
    await t.type(body, `${TEXT}- ${"x".repeat(200)}\n`);
    expect(t.editor()!.querySelector('[role="alert"]')!.textContent).toMatch(/^\d+ of 120 bytes: too long to save$/);
    expect(t.button(/^Save$/)!.disabled).toBe(true);
    await t.key(body, "Enter", { ctrlKey: true });
    expect(t.calls.some((c) => c.startsWith("write"))).toBe(false);
    // Under the cap again, it saves.
    await t.type(body, "- Short.\n");
    expect(t.button(/^Save$/)!.disabled).toBe(false);
  });

  it("a file changed since it was opened is not written over: it says so, loads the newest and keeps the edit to copy", async () => {
    let reads = 0;
    const t = await open(agent(true), {
      corrections: async () => (++reads === 1 ? { text: TEXT, etag: '"c-v1"', cap_bytes: 2048 } : { text: "# Learned\n\n- A run's newest correction.\n", etag: '"c-v2"', cap_bytes: 2048 }),
      write: async (_text, etag) => { if (etag === '"c-v1"') throw new ClientError(412, "precondition_failed", "corrections.md changed since it was read."); return { text: "", etag: '"c-v3"', cap_bytes: 2048 }; },
    });
    await t.click(/^Edit corrections$/);
    await t.type(t.editor()!.querySelector("textarea")!, "- My edit.\n");
    await t.click(/^Save$/);
    expect(t.text()).toContain("Changed since you opened it");
    expect(t.text()).toContain("This is the newest version. Your edit wasn't saved; it's below to copy.");
    expect(t.editor()!.querySelector("textarea")!.value).toBe("# Learned\n\n- A run's newest correction.\n");
    expect(t.editor()!.querySelector("pre")!.textContent).toBe("- My edit.\n");
    // Saved again, it is made on the newest version.
    await t.click(/^Save$/);
    expect(t.calls.filter((c) => c.startsWith("write")).map((c) => c.split(" ")[1])).toEqual(['"c-v1"', '"c-v2"']);
    expect(t.editor()).toBeNull();
  });

  it("one the checks refuse lists why, and stays open", async () => {
    const t = await open(agent(true), { write: async () => { throw Object.assign(new ClientError(400, "bad_request", "corrections.md does not pass the checks: secret_value."), { problems: [{ rule: "secret_value", path: "corrections.md", detail: "it holds the value of one of this server's secrets" }] }); } });
    await t.click(/^Edit corrections$/);
    await t.click(/^Save$/);
    expect(t.text()).toContain("Not saved: it doesn't pass the checks.");
    expect(t.text()).toContain("it holds the value of one of this server's secrets");
    expect(t.editor()).not.toBeNull();
  });

  it("any other refusal says the corrections were not saved, and stays open", async () => {
    const t = await open(agent(true), { write: async () => { throw new ClientError(413, "payload_too_large", "corrections.md holds at most 2048 bytes."); } });
    await t.click(/^Edit corrections$/);
    await t.click(/^Save$/);
    expect(t.text()).toContain("The corrections were not saved.");
    expect(t.text()).toContain("corrections.md holds at most 2048 bytes.");
    expect(t.editor()).not.toBeNull();
  });

  it("a read that fails says so, and Try again reads it", async () => {
    let reads = 0;
    const t = await open(agent(true), { corrections: async () => { if (reads++ === 0) throw new ClientError(503, "unavailable", "The server is restarting."); return { text: TEXT, etag: '"c-v1"', cap_bytes: 2048 }; } });
    await t.click(/^Edit corrections$/);
    expect(t.editor()!.querySelector("textarea")).toBeNull();
    expect(t.button(/^Save$/)!.disabled).toBe(true);
    await t.click(/^Try again$/);
    expect(t.editor()!.querySelector("textarea")!.value).toBe(TEXT);
  });

  it("an agent with none says how one is given, and Edit starts it", async () => {
    const t = await open(agent(true), { learning: async () => none(), corrections: async () => ({ text: "", etag: '"c-v0"', cap_bytes: 2048 }) });
    const section = t.host.querySelector('section[aria-label="Corrections"]')!;
    expect(section.textContent).toContain("None yet. A correction you give with a run's grade is kept here, one line each; every later run is given them whole.");
    await t.click(/^Edit corrections$/);
    await t.type(t.editor()!.querySelector("textarea")!, "- Prices in the shop's currency.\n");
    await t.click(/^Save$/);
    expect(t.calls).toContain(`write "c-v0" ${JSON.stringify("- Prices in the shop's currency.\n")}`);
  });

  it("a refresh that fails after a save says so beside what is shown, and Try again reads it again", async () => {
    let reads = 0;
    const t = await open(agent(true), { learning: async () => { reads++; if (reads === 2) throw new TypeError("Failed to fetch"); return reads === 1 ? view() : view({ corrections: "# Learned\n\n- Saved and read.\n" }); } });
    await t.click(/^Edit corrections$/);
    await t.click(/^Save$/);
    expect(reads).toBe(2);
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't refresh what it learned: can't reach agentrun-serve. What's shown may be out of date.");
    expect(t.text()).toContain("Keep the answer to three lines.");
    await t.click(/^Try again$/);
    expect(t.text()).toContain("Saved and read.");
    expect(t.text()).not.toContain("Couldn't refresh what it learned");
  });
});

describe("what runs did not keep", () => {
  it("lists a refused draft and a skip with their words, newest first, and counts the runs with nothing new", async () => {
    const t = await open(agent(true));
    const list = t.host.querySelector('section[aria-label="Kept nothing"]')!;
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("Not kept: the draft did not pass the checks.");
    expect(rows[0]).toContain("kith.com");
    expect(rows[1]).toContain("Skipped: no budget left in this run to write what it learned.");
    expect(rows).toHaveLength(2);
    expect(list.textContent).toContain("2 more runs had nothing new to compile.");
    expect(list.textContent).not.toMatch(/remember|look back|notes/);
  });

  it("lists each sentence as served, under a title that does not say Not kept again", async () => {
    const shapes = ["Not kept: the draft did not pass the checks.", "Not kept, the workflow sort-invoice: it named a value the server keeps secret."];
    const runs = shapes.map((detail, i) => runOf(`run-d${i}`, `shop${i}.com`, { at: "2026-11-03T16:52:09Z", state: "dropped", reason: "checker", detail }));
    const t = await open(agent(true), { runs });
    const panel = t.host.querySelector('section[aria-label="Kept nothing"]')!;
    expect(panel.querySelector("h2")!.textContent).not.toContain("Not kept");
    expect([...panel.querySelectorAll("li")].map((li) => li.querySelector("span")!.textContent)).toEqual(shapes);
  });
});

describe("the before and after", () => {
  const IMPACT = { before: { runs: 2, median_duration_s: 18 }, after: { runs: 4, median_duration_s: 12 } };
  it("shows run time before and after it learned, on the after side's runs, in words that name a correction or a workflow, and no cost of a run of its own", async () => {
    const t = await open(agent(true), { learning: async () => view({ impact: IMPACT }) });
    const card = t.host.querySelector('section[aria-label^="Since it learned"]')!;
    expect(card.getAttribute("aria-label")).toBe("Since it learned (medians of 4 runs started from what it learned): answers in 12s instead of 18s");
    expect(card.textContent).toContain("Answers in12sinstead of 18s−33%");
    // A run's cost is the cost card's all-in before and after, learning included: a median of the job's own cost here
    // left learning out and read -86% beside the cost card's 2.0x cheaper.
    expect(card.textContent).not.toContain("A run costs");
    expect(card.textContent).not.toContain("Learning itself");
    expect(card.querySelector('[title^="Medians of"]')!.getAttribute("title")).toBe("Medians of 2 runs before it first learned and 4 runs that started from what it learned (a correction or a workflow).");
  });
  it("says what learning itself costs a run from the bill (compile turns, audit shadows, replays over its runs), and a slower after as it is, in the warning colour", async () => {
    const cost = async (): Promise<LearningCost> => ({ agent: "refunds", runs: [], total_runs: 9, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [], bill: { ...BILL, learning_usd: 0.0675 } });
    // Learning's cost is the bill's: the impact has no figure of its own (its old median of mostly-zero rows read $0).
    const t = await open(agent(true), { cost, learning: async () => view({ impact: { before: { runs: 2, median_duration_s: 1.2 }, after: { runs: 4, median_duration_s: 1.3 } } }) });
    const card = t.host.querySelector('section[aria-label^="Since it learned"]')!;
    expect(card.textContent).toContain("Learning itself$0.0075 a run, booked");
    expect(card.textContent).not.toContain("$0.0000");
    const up = [...card.querySelectorAll("span")].find((x) => x.textContent === "+8%")!;
    expect(card.textContent).toContain("Answers in1.3sinstead of 1.2s+8%");
    expect(up.className).toContain("text-warning-text");
  });
  it("renders for an agent that learned only a workflow", async () => {
    const t = await open(agent(true), { learning: async () => view({ corrections: "", workflows: [flow()], impact: IMPACT }) });
    expect(t.host.querySelector('section[aria-label^="Since it learned"]')).not.toBeNull();
  });
  it("is hidden when the server has none", async () => {
    const t = await open(agent(true), { learning: async () => view({ impact: null }) });
    expect(t.host.querySelector('section[aria-label^="Since it learned"]')).toBeNull();
  });
});

describe("the switch and the empty states", () => {
  it("with nothing learned and learning off: one sentence on what learning is, and the switch, which saves a revision with learning on", async () => {
    const t = await open(agent(undefined), { learning: async () => view({ main: null, corrections: "", log: { items: [], total: 0, next_cursor: null } }), runs: [] });
    expect(t.text()).toContain("Learning is off for this agent.");
    expect(t.text()).toContain("With learning on, every later run is given your corrections, and a job it does again compiles into a workflow.");
    const sw = t.host.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => { sw.click(); });
    await settle();
    const put = t.calls.find((c) => c.startsWith("put "))!;
    expect(JSON.parse(put.slice(4, put.lastIndexOf(" ")))).toMatchObject({ definition: { learning: true, version: 2 }, note: "Learning on" });
    expect(put.endsWith('"rv1"')).toBe(true);
    expect(t.agents.at(-1)?.definition.learning).toBe(true);
  });
  it("a failed switch says so and goes back", async () => {
    const t = await open(agent(undefined), { learning: async () => none(), runs: [], update: async () => { throw new ClientError(412, "precondition_failed", "Another revision was saved first."); } });
    const sw = t.host.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    await settle();
    expect(t.text()).toContain("Learning was not changed.");
    expect(t.text()).toContain("Another revision was saved first. · precondition_failed");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
  it("enabling an existing eve agent enables learning for its next ordinary task", async () => {
    const t = await open(agent(false, { sdk: { runtime: "eve" } }));
    await act(async () => { (t.host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    const put = t.calls.find((call) => call.startsWith("put "))!;
    expect(JSON.parse(put.slice(4, put.lastIndexOf(" ")))).toMatchObject({
      definition: { learning: true, sdk: { runtime: "eve" }, version: 2 }, note: "Learning on",
    });
    expect(put.endsWith('"rv1"')).toBe(true);
    expect(t.agents.at(-1)?.definition.learning).toBe(true);
  });
  it("turning eve learning Off still saves false", async () => {
    const t = await open(agent(undefined, { learning: true, sdk: { runtime: "eve" } }));
    await act(async () => { (t.host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    expect(t.agents.at(-1)?.definition.learning).toBe(false);
  });
  it.each([true, { compile_after: 5, agree_min: 0.95 }] as const)("an enable click preserves the freshly read %s mode without another revision", async learning => {
    const current = agent(false, { sdk: { runtime: "eve" } });
    const t = await open(current);
    // Another client saved a mode after this page rendered Off. getAgent reads that latest value.
    current.definition.learning = learning;
    await act(async () => { (t.host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    expect(t.calls.some(call => call.startsWith("put "))).toBe(false);
    expect(t.agents.at(-1)?.definition.learning).toBe(learning);
  });
  it("with learning on and nothing learned yet: says so, how many runs looked back, and the corrections can be written", async () => {
    const t = await open(agent(true), { learning: async () => none(), runs: [RUNS[0], RUNS[2]] });
    expect(t.text()).toContain("Nothing learned yet");
    expect(t.text()).toContain("2 runs had their compile turn: no workflow kept yet.");
    expect(t.text()).not.toMatch(/looked back|look-back/);
    expect(t.button(/^Edit corrections$/)).toBeTruthy();
  });
  it("learning set as an object is on: the switch shows it on", async () => {
    const t = await open(agent(undefined, { learning: { agree_min: 0.9 } }));
    expect((t.host.querySelector('[role="switch"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  });
  it("corrections kept while learning is off say later runs aren't given them", async () => {
    const t = await open(agent(false));
    expect(t.text()).toContain("Learning is off, so later runs aren't given these corrections or workflows.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const t2 = await open(agent(true), {}, { server: "off" });
    expect(t2.text()).toContain("This server has learning turned off");
  });
  it("an archived agent's corrections and workflows are shown, and nothing offers to change them", async () => {
    const t = await open({ ...agent(true), archived_at: "2026-11-03T17:00:00Z" }, { learning: async () => view({ workflows: [flow(), flow("retired", { name: "old-flow", file: "workflows/old-flow/workflow.json", readme: "workflows/old-flow/README.md" })] }) });
    expect(t.text()).toContain("Keep the answer to three lines.");
    expect(t.card("check-refunds")).not.toBeNull();
    expect(t.button(/^Edit corrections$/)).toBeUndefined();
    expect(t.button(/^Retire check-refunds$/)).toBeUndefined();
    await t.click(/^Earlier workflows/);
    expect(t.button(/^Restore old-flow$/)).toBeUndefined();
    expect((t.host.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("loading and errors", () => {
  it("shows placeholders while it reads, then the corrections", async () => {
    let release!: (v: AgentLearning) => void;
    const t = await open(agent(true), { learning: () => new Promise((r) => { release = r; }) });
    const loading = t.host.querySelector('[aria-busy="true"]')!;
    expect([loading.getAttribute("role"), loading.getAttribute("aria-label")]).toEqual(["status", "Loading what it learned"]);
    expect(loading.innerHTML).toContain("motion-safe:animate-pulse");
    expect(loading.innerHTML).not.toMatch(/(^|[\s"])animate-pulse/);
    await act(async () => { release(view()); });
    await settle();
    expect(t.text()).toContain("Keep the answer to three lines.");
  });
  it("a failed read says so with the server's message, and reads again on Try again", async () => {
    let n = 0;
    const t = await open(agent(true), { learning: async () => { if (n++ === 0) throw new ClientError(500, "internal", "The agent's learning could not be read."); return view(); } });
    expect(t.text()).toContain("What this agent learned could not be read.");
    expect(t.text()).toContain("The server hit a problem on its side.");
    expect(t.text()).toContain("The agent's learning could not be read. · internal");
    await t.click(/Try again/);
    expect(t.text()).toContain("Keep the answer to three lines.");
  });
});

describe("the Learning tab's workflows", () => {
  it("lists each by name, description and the run that kept it, opening to its workflow.json read when opened; nothing edits it", async () => {
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }) });
    const section = t.host.querySelector('section[aria-label="Workflows it learned"]') as HTMLElement;
    expect(section.textContent).toContain("1 workflow: a job it does again, as steps a later run can call.");
    const card = t.card("check-refunds")!;
    expect(section.contains(card)).toBe(true);
    expect(card.textContent).toContain("Checks a store's refund window");
    expect(card.textContent).toContain("Learned in");
    expect(card.querySelector('a[href="#/runs/run-a"]')?.textContent).toBe("run-a");
    expect(t.calls.some((c) => c.startsWith("read "))).toBe(false);
    await t.click(/^Show the workflow check-refunds$/);
    expect(t.calls).toContain(`read ${DRAFT_FILE}`);
    expect(card.textContent).toContain('"name": "check-refunds"');
    expect(t.button(/^Edit check-refunds$/)).toBeUndefined();
  });

  it("an agent with none shows no workflows section", async () => {
    const t = await open(agent(true));
    expect(t.host.querySelector('section[aria-label="Workflows it learned"]')).toBeNull();
  });

  it("a text that could not be read is read again by Try again, the card staying open", async () => {
    let tries = 0;
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), read: async () => { tries++; if (tries === 1) throw new Error("down"); return { text: '{"v": 2, "name": "check-refunds"}\n', etag: '"wf-v1"' }; } });
    await t.click(/^Show the workflow check-refunds$/);
    expect(t.card("check-refunds")!.textContent).not.toContain('"name": "check-refunds"');
    await t.click(/^Try again$/);
    expect(tries).toBe(2);
    expect(t.card("check-refunds")!.textContent).toContain('"name": "check-refunds"');
  });

  it("an opened one shows text in angle brackets as written", async () => {
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), read: async () => ({ text: '{"template": "Customer: <name>, Amount: $<amount>"}\n', etag: '"wf-v1"' }) });
    await t.click(/^Show the workflow check-refunds$/);
    expect(t.card("check-refunds")!.textContent).toContain("Customer: <name>, Amount: $<amount>");
  });

  describe("waiting for the owner's OK", () => {
    const caps = { learning: { pending: true, approve: true } };
    it("says so, and on a server that approves from the console Approve is one click on its README's listed version", async () => {
      const changed = vi.fn();
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow("pending")] }), caps }, { onChanged: changed });
      expect(t.calls).toContain("capabilities");
      expect(t.card("check-refunds")!.textContent).toContain("Waits for your OK");
      expect(changed).not.toHaveBeenCalled();
      await t.click(/^Approve check-refunds$/);
      expect(t.calls).toContain(`approve ${README_FILE} "readme-v1"`);
      expect(t.calls.some((c) => c.startsWith(`approve ${DRAFT_FILE}`))).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
    });
    it("without the owner's password sign-in, says why, and there is no Approve", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow("pending")] }), caps: { learning: { pending: true, approve: false, approve_needs: "password" } } });
      expect(t.card("check-refunds")!.textContent).toContain("Approving needs your password sign-in.");
      expect(t.button(/^Approve check-refunds$/)).toBeUndefined();
    });
    it("there is nothing to approve when none waits, and the capabilities are not even read", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), caps });
      expect(t.calls).not.toContain("capabilities");
      expect(t.button(/^Approve /)).toBeUndefined();
    });
    it("an approve answered 412 says it changed, and the tab is not read again", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow("pending")] }), caps, approve: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
      await t.click(/^Approve check-refunds$/);
      expect(t.card("check-refunds")!.textContent).toContain("It changed since you opened it. Reload the tab to see the newest version.");
      expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(1);
    });
    it("an approve that landed, then a re-read that failed, leaves Approve usable again, never stuck on Approving", async () => {
      let n = 0;
      let fail!: (e: unknown) => void;
      const t = await open(agent(true), { learning: () => (n++ === 0 ? Promise.resolve(view({ workflows: [flow("pending")] })) : new Promise<AgentLearning>((_, reject) => { fail = reject; })), caps });
      await t.click(/^Approve check-refunds$/);
      const during = t.button(/^Approve check-refunds$/) as HTMLButtonElement;
      expect([during.textContent, during.disabled]).toEqual(["Approving", true]);
      await act(async () => { fail(new ClientError(503, "unavailable", "The server is restarting.")); });
      await settle();
      expect(t.text()).toContain("Couldn't refresh what it learned");
      const after = t.button(/^Approve check-refunds$/) as HTMLButtonElement;
      expect([after.textContent, after.disabled]).toEqual(["Approve", false]);
    });
  });

  describe("retiring one", () => {
    it("asks first; Esc or Keep leaves it; Yes retires it by its README on the listed version, with no read, and it moves under Earlier workflows", async () => {
      let n = 0;
      const t = await open(agent(true), { learning: async () => (++n === 1 ? view({ workflows: [flow()] }) : view({ workflows: [flow("retired")] })) });
      await t.click(/^Retire check-refunds$/);
      const dialog = t.host.querySelector('[role="alertdialog"]')!;
      expect(dialog.getAttribute("aria-label")).toBe("Retire check-refunds?");
      expect(dialog.textContent).toContain("Retire it? Later runs stop getting it. It stays under Earlier workflows.");
      expect(document.activeElement?.textContent).toBe("Yes, retire");
      await t.key(dialog, "Escape");
      expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
      await t.click(/^Retire check-refunds$/);
      await t.click(/^Keep$/);
      expect(t.calls.some((c) => c.startsWith("retire"))).toBe(false);
      await t.click(/^Retire check-refunds$/);
      await t.click(/^Yes, retire$/);
      expect(t.calls).toContain(`retire ${README_FILE} "readme-v1"`);
      expect(t.calls.some((c) => c.startsWith(`retire ${DRAFT_FILE}`))).toBe(false);
      expect(t.calls.some((c) => c.startsWith("read"))).toBe(false);
      expect(t.card("check-refunds")).toBeNull();
      const flows = t.host.querySelector('section[aria-label="Workflows it learned"]') as HTMLElement;
      expect(flows.textContent).toContain("No workflow is in use: the next run gets none.");
      expect(flows.querySelector('section[aria-label="Earlier workflows"]')?.textContent).toContain("Earlier workflows1 no longer given");
    });
    it("a retire that landed stays Retiring while the tab reads the list again; a re-read that fails leaves Retire usable", async () => {
      let n = 0;
      let fail!: (e: unknown) => void;
      const t = await open(agent(true), { learning: () => (n++ === 0 ? Promise.resolve(view({ workflows: [flow()] })) : new Promise<AgentLearning>((_, reject) => { fail = reject; })) });
      await t.click(/^Retire check-refunds$/);
      await t.click(/^Yes, retire$/);
      const during = t.button(/^Retiring$/) as HTMLButtonElement;
      expect(during.disabled).toBe(true);
      await act(async () => { fail(new ClientError(503, "unavailable", "The server is restarting.")); });
      await settle();
      expect(t.text()).toContain("Couldn't refresh what it learned");
      expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
      const after = t.button(/^Retire check-refunds$/) as HTMLButtonElement;
      expect([after.textContent, after.disabled]).toEqual(["Retire", false]);
    });
    it("one that changed since the listing (412) says so, and is not retired", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), retire: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
      await t.click(/^Retire check-refunds$/);
      await t.click(/^Yes, retire$/);
      expect(t.card("check-refunds")!.textContent).toContain("It changed since you opened it. Reload the tab to see the newest version.");
      expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(1);
    });
    it("any other refusal says the workflow was not retired", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), retire: async () => { throw new ClientError(400, "bad_request", "A workflow is retired by its README.md."); } });
      await t.click(/^Retire check-refunds$/);
      await t.click(/^Yes, retire$/);
      expect(t.card("check-refunds")!.textContent).toContain("The workflow was not retired.");
    });
  });

  describe("retired ones", () => {
    it("say who retired them and when, open to their text, and have no Approve or Retire", async () => {
      const v = view({ workflows: [flow("retired", { retired: { at: "2026-11-04T10:00:00Z", by: "person", from: "active" } }), flow("retired", { name: "by-run", file: "workflows/by-run/workflow.json", readme: "workflows/by-run/README.md", retired: { at: "2026-11-04T10:00:00Z", by: "run", from: "active" } })] });
      const t = await open(agent(true), { learning: async () => v, read: async () => ({ text: '{"v": 2, "name": "check-refunds"}\n', etag: '"wf-v1"' }) });
      await t.click(/^Earlier workflows/);
      const earlier = t.host.querySelector('section[aria-label="Earlier workflows"]') as HTMLElement;
      expect(earlier.textContent).toMatch(/Retired by you · \S/);
      expect(earlier.textContent).toMatch(/Retired by a run · \S/);
      await t.click(/^Show the workflow check-refunds$/);
      expect(t.calls).toContain(`read ${DRAFT_FILE}`);
      expect(earlier.textContent).toContain('"name": "check-refunds"');
      expect(earlier.querySelector('a[href="#/runs/run-a"]')?.textContent).toBe("run-a");
      expect(t.button(/^Retire check-refunds$/)).toBeUndefined();
      expect(t.button(/^Approve check-refunds$/)).toBeUndefined();
    });
    it("one that reads retired only because its README can't be read says so, and how to fix it, never who retired it", async () => {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow("retired", { retired: { at: "2026-11-04T10:00:00Z", by: "host", why: "unreadable" } })] }) });
      await t.click(/^Earlier workflows/);
      const earlier = t.host.querySelector('section[aria-label="Earlier workflows"]')!.textContent!;
      expect(earlier).toContain("Not read: its front matter can't be read; fix the file to use it");
      expect(earlier).not.toMatch(/Retired by/);
    });
    it("one the server names no retirement of says just Retired, and no more of the log is read for it", async () => {
      const v = view({ workflows: [flow("retired")] });
      v.log = { ...v.log, items: [{ by: { user: true }, commit: "c9", at: "2026-11-04T10:00:00Z", reason: "retired by a person", files: [README_FILE] }, ...v.log.items], next_cursor: "l1" };
      const t = await open(agent(true), { learning: async () => v });
      await t.click(/^Earlier workflows/);
      const earlier = t.host.querySelector('section[aria-label="Earlier workflows"]')!.textContent ?? "";
      expect(earlier).toContain("Retired");
      expect(earlier).not.toContain("by you");
    });
    it("an open retired one reads its text again when the list moves to another version, and a late read of the old one never lands", async () => {
      let version = '"wf-v1"';
      let release: () => void = () => {};
      let reads = 0;
      const t = await open(agent(true), {
        learning: async () => view({ workflows: [flow("retired", { etag: version })] }),
        read: async () => {
          if (reads++ === 0) return new Promise((done) => { release = () => done({ text: "the old text", etag: '"wf-v1"' }); });
          return { text: "the newer text", etag: version };
        },
        restore: async () => { version = '"wf-v3"'; throw new ClientError(412, "precondition_failed", "changed"); },
      });
      await t.click(/^Earlier workflows/);
      await t.click(/^Show the workflow check-refunds$/);
      await t.click(/^Restore check-refunds$/);
      await t.click(/^Yes, restore$/);
      expect(t.text()).toContain("It changed since you opened it.");
      const earlier = () => t.host.querySelector('section[aria-label="Earlier workflows"]')?.textContent ?? "";
      expect(earlier()).toContain("the newer text");
      await act(async () => { release(); });
      await settle();
      expect(earlier()).toContain("the newer text");
      expect(earlier()).not.toContain("the old text");
    });
  });

  describe("restoring one", () => {
    const retired = (from: "active" | "pending" = "active") => view({ workflows: [flow("retired", { etag: '"readme-v9"', retired: { at: "2026-11-04T09:10:00Z", by: "person", from } })] });
    const restoreOf = async (t: Awaited<ReturnType<typeof open>>) => { await t.click(/^Earlier workflows/); await t.click(/^Restore check-refunds$/); };
    it("asks first, then restores by its README on the listed version, and reads the tab again", async () => {
      let reads = 0;
      const t = await open(agent(true), { learning: async () => { reads++; return retired(); } });
      await restoreOf(t);
      expect(t.host.querySelector('[role="alertdialog"]')?.textContent).toContain("It becomes active again for the next run.");
      expect(t.calls.some((c) => c.startsWith("restore "))).toBe(false);
      const before = reads;
      await t.click(/^Yes, restore$/);
      expect(t.calls).toContain(`restore ${README_FILE} "readme-v9"`);
      expect(reads).toBeGreaterThan(before);
    });
    it("one that waited for your OK before its retire says it goes back to waiting", async () => {
      const t = await open(agent(true), { learning: async () => retired("pending") });
      await restoreOf(t);
      const ask = t.host.querySelector('[role="alertdialog"]')?.textContent ?? "";
      expect(ask).toContain("It goes back to waiting for your OK: no run uses it until you approve it.");
      expect(ask).not.toContain("active again");
    });
    it("a refusal by the checks shows the server's words, and it stays retired", async () => {
      const refusal = Object.assign(new ClientError(400, "bad_request", "The draft does not pass the checks: secret_shape."), { problems: [{ rule: "secret_shape", path: DRAFT_FILE, detail: "It holds something shaped like a key." }] });
      const t = await open(agent(true), { learning: async () => retired(), restore: async () => { throw refusal; } });
      await restoreOf(t);
      await t.click(/^Yes, restore$/);
      expect(t.text()).toContain("It holds something shaped like a key.");
      expect(t.host.querySelector('section[aria-label="Earlier workflows"]')!.textContent).toContain("check-refunds");
    });
    it("a token, not the owner's sign-in, is told restoring takes the password sign-in", async () => {
      const t = await open(agent(true), { learning: async () => retired(), restore: async () => { throw new ClientError(403, "forbidden", "Restoring takes the owner's password sign-in in the console, never a token."); } });
      await restoreOf(t);
      await t.click(/^Yes, restore$/);
      expect(t.text()).toContain("Restoring takes your password sign-in in the console.");
    });
    it("one no longer retired (restored elsewhere) reads the tab again", async () => {
      let reads = 0;
      const t = await open(agent(true), { learning: async () => { reads++; return retired(); }, restore: async () => { throw new ClientError(400, "bad_request", "The draft is not retired: it is active."); } });
      await restoreOf(t);
      const before = reads;
      await t.click(/^Yes, restore$/);
      expect(reads).toBeGreaterThan(before);
    });
  });

  it("says Approved by you or Restored by you when the server names it, and a person's change in the log alone gives no by-line", async () => {
    const AT = "2026-11-05T19:30:00Z";
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow("serving", { last_change: { kind: "approved", by: "person", at: AT } }), flow("serving", { name: "restored-flow", file: "workflows/restored-flow/workflow.json", readme: "workflows/restored-flow/README.md", last_change: { kind: "restored", by: "person", at: AT } }), flow("serving", { name: "plain-flow", file: "workflows/plain-flow/workflow.json", readme: "workflows/plain-flow/README.md" })] }) });
    expect(t.card("check-refunds")!.textContent).toMatch(/Approved by you · \S/);
    expect(t.card("restored-flow")!.textContent).toMatch(/Restored by you · \S/);
    expect(t.card("plain-flow")!.textContent).not.toMatch(/by you/);
  });
});

describe("the Learning tab's learned workflow, drawn", () => {
  const DOC = { v: 2, name: "check-refunds", schemas: { In: { type: "object" }, Page: { type: "object" } }, input: { schemaId: "In" }, root: { node: "chain", label: "check refunds", steps: [
    { node: "call", label: "fetch the policy page", via: "tool", tool: "web_fetch", args: { url: "{url}" }, out: "Page", as: "page" },
    { node: "extract", label: "read the refund window", from: "{page}", out: "Page", as: "window" },
  ] } };
  it("an active one opens to its graph: each node drawn by its label, and the JSON behind it", async () => {
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), read: async () => ({ text: `${JSON.stringify(DOC, null, 2)}\n`, etag: '"wf-v1"' }) });
    await t.click(/^Show the workflow check-refunds$/);
    const card = t.card("check-refunds")!;
    const graph = card.querySelector('svg[role="img"][aria-label="The workflow check-refunds, as a graph"]');
    expect(graph).not.toBeNull();
    expect(graph!.textContent).toContain("fetch the policy page");
    expect(graph!.textContent).toContain("read the refund window");
    expect(card.textContent).toContain('"name": "check-refunds"');
  });
  it("a workflow.json that is not a workflow (no root, or not JSON) shows its text as it is, with no graph", async () => {
    for (const text of ['{"v": 2, "name": "check-refunds"}\n', "not json"]) {
      const t = await open(agent(true), { learning: async () => view({ workflows: [flow()] }), read: async () => ({ text, etag: '"wf-v1"' }) });
      await t.click(/^Show the workflow check-refunds$/);
      const card = t.card("check-refunds")!;
      expect(card.querySelector('svg[role="img"]')).toBeNull();
      expect(card.querySelector("pre")!.textContent).toBe(text);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
});

describe("what the next run is given", () => {
  it("counts the corrections and names the active workflows, leaving out one that waits", async () => {
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow(), flow("pending", { name: "waits-flow", file: "workflows/waits-flow/workflow.json", readme: "workflows/waits-flow/README.md" })] }) });
    const panel = t.host.querySelector('section[aria-label="What the next run is given"]')!;
    expect(panel.textContent).toContain("2 corrections and 1 workflow.");
    expect(panel.textContent).toContain("Workflows: check-refunds (serving)");
    expect(panel.textContent).not.toContain("waits-flow");
  });
  it("says where each workflow stands, as the server says it: one whose check held and stopped never reads as serving", async () => {
    const stopped = flow("stopped", { name: "stopped-flow", file: "workflows/stopped-flow/workflow.json", readme: "workflows/stopped-flow/README.md" });
    const t = await open(agent(true), { learning: async () => view({ workflows: [flow(), stopped] }) });
    expect(t.card("check-refunds")!.textContent).toContain("Serving");
    expect(t.card("stopped-flow")!.textContent).toContain("Stopped");
    expect(t.card("stopped-flow")!.textContent).not.toContain("Serving");
    expect(t.host.querySelector('section[aria-label="What the next run is given"]')!.textContent).toContain("Workflows: check-refunds (serving), stopped-flow (stopped)");
    act(() => root?.unmount()); document.body.innerHTML = "";
    // Review on #3179: a revision being checked while an older one still serves: the older one keeps the runs, and the
    // agent takes them only when none serves.
    const checking = flow("checking", { name: "checking-flow", file: "workflows/checking-flow/workflow.json", readme: "workflows/checking-flow/README.md" });
    const t2 = await open(agent(true), { learning: async () => view({ workflows: [checking] }) });
    const chip = [...t2.card("checking-flow")!.querySelectorAll("[title]")].find((one) => one.textContent === "Checking")!;
    expect(chip.getAttribute("title")).toContain("The previous revision keeps serving meanwhile");
    expect(chip.getAttribute("title")).toContain("the agent takes the runs only when none serves");
  });
  it("says the next run gets nothing when learning is off, for the agent or on this server", async () => {
    const t = await open(agent(false));
    expect(t.host.querySelector('section[aria-label="What the next run is given"]')!.textContent).toContain("Learning is off: the next run gets no corrections or workflows.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const t2 = await open(agent(true), {}, { server: "off" });
    expect(t2.host.querySelector('section[aria-label="What the next run is given"]')!.textContent).toContain("Learning is off: the next run gets no corrections or workflows.");
  });
});

describe("the loop on the Learning tab", () => {
  it("early: says how far it is from a compile, at the definition's compile_after completed runs (20 by default)", async () => {
    const runs = [runOf("run-ok", "kith.com", null)];
    const loop = async () => ({ agent: "refunds", completed_runs: 1, compiles: [] }) as LearningLoop;
    const t = await open(agent(true, { learning: { compile_after: 5 } }), { runs, loop });
    const stage = t.host.querySelector('[data-testid="stage-compiled"]')!;
    expect(stage.getAttribute("data-state")).toBe("now");
    expect(stage.textContent).toContain("1 of 5 completed runs: a workflow compiles at 5");
    const byDefault = await open(agent(true), { runs, loop });
    expect(byDefault.host.querySelector('[data-testid="stage-compiled"]')!.textContent).toContain("1 of 20 completed runs: a workflow compiles at 20");
  });
  it("the compile count is the server's, never the runs on the tab's one page: 150 of 200 with 50 runs read", async () => {
    const runs = Array.from({ length: 50 }, (_, i) => runOf(`run-${i}`, `in-${i}`, null));
    const loop = async () => ({ agent: "refunds", completed_runs: 150, compiles: [] }) as LearningLoop;
    const t = await open(agent(true, { learning: { compile_after: 200 } }), { runs, loop });
    expect(t.host.querySelector('[data-testid="stage-compiled"]')!.textContent).toContain("150 of 200 completed runs");
  });
  it("the cheaper stage: 'N times cheaper' (the chart's ratio) over the agreement check it passed (N of M agreed, its bar) when the serving check cleared, never 'the same accuracy'; the reason in its place when a run's cost isn't all known", async () => {
    const took = { takeover: { n: 19, run_id: "r19" }, before: { runs: 18, mean_usd: 0.89 }, after: { runs: 59, mean_usd: 0.127 }, after_state: "priced" as const, hand_backs: { ran: 59, back: 3 } };
    const costOf = (over: Partial<LearningCost["summary"]>) => async (): Promise<LearningCost> => ({ agent: "refunds", runs: [], total_runs: 77, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { ...took, times_cheaper: 7, withheld: null, replay: { n: 40, workflow_pct: 80, agent_pct: 100, cleared: true, agreed: 32, alone: 40, agree_min: 0.8 }, ...over }, workflows: [], bill: EMPTY_BILL });
    const t = await open(agent(true), { cost: costOf({}) });
    const stage = t.host.querySelector('[data-testid="stage-cheaper"]')!;
    expect(stage.querySelector('[data-testid="stage-cheaper-value"]')!.textContent).toBe("7.0x cheaper");
    expect(stage.textContent).toContain("Passed the agreement check: 32 of 40 agreed (bar 80%) · served 59 runs, handed back 3");
    expect(stage.textContent).not.toMatch(/same accuracy/);
    act(() => root!.unmount());
    const held = await open(agent(true), { cost: costOf({ times_cheaper: null, withheld: { unknown: 3, at_most: 1 } }) });
    const withheld = held.host.querySelector('[data-testid="stage-cheaper"]')!;
    expect(withheld.textContent).toContain("3 runs' cost unknown, 1 known only as at most");
    expect(withheld.textContent).not.toMatch(/\dx cheaper/);
  });
  it("a draft the checks refused shows in the feed in their words; a failed loop read leaves the feed out, not the tab", async () => {
    const loop = { agent: "refunds", completed_runs: 0, compiles: [{ run_id: "run-x", round: 1, at: "2026-11-05T10:00:00Z", workflow: null, attempts: [{ ok: false, errors: ["root: no node"] }], digest: null, promoted: null, draft_errors: ["the draft did not parse"], withheld: false }] } as LearningLoop;
    const t = await open(agent(true), { loop: async () => loop });
    const feed = t.host.querySelector('[data-testid="loop-feed"]')!;
    expect(feed.textContent).toContain("Draft failed");
    expect([...feed.querySelectorAll('[data-testid="draft-errors"] li')].map((li) => li.textContent)).toEqual(["Attempt 1: root: no node", "the draft did not parse"]);
    expect(t.host.querySelector('[data-testid="stage-compiled"]')!.getAttribute("data-state")).toBe("warn");
    act(() => root!.unmount());
    const broken = await open(agent(true), { loop: async () => { throw new Error("down"); } });
    expect(broken.host.querySelector('[data-testid="loop-feed"]')).toBeNull();
    expect(broken.text()).toContain("Keep the answer to three lines.");
  });
  it("a compile's chip in the feed says Serving only for the champion: an older promoted revision Served", async () => {
    const [one, two, three] = ["a".repeat(16), "b".repeat(16), "c".repeat(16)];
    const compile = (run: string, digest: string, round = 1) => ({ run_id: run, round, at: `2026-11-05T10:0${digest === one ? 0 : digest === two ? 1 : 2}:00Z`, workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest, promoted: true, draft_errors: [], withheld: false });
    const loop = { agent: "refunds", completed_runs: 0, compiles: [compile("run-c", three), compile("run-b", two), compile("run-a", one, 2)] } as LearningLoop;
    const base = { workflow: "sort-invoice", reason: "as good" };
    const promotions = [
      { ...base, digest: one, at: "2026-11-05T10:03:00Z", decided: "promote" as const },
      { ...base, digest: two, at: "2026-11-05T10:04:00Z", decided: "promote" as const },
      { ...base, digest: three, at: "2026-11-05T10:05:00Z", decided: "promote" as const },
    ];
    const t = await open(agent(true), { loop: async () => loop, promotions: async () => ({ agent: "refunds", promotions, serving: [{ workflow: "sort-invoice", digest: three, replaying: null }] }) as Promotions });
    const chips = [...t.host.querySelectorAll('[data-testid="loop-feed"] [data-testid="feed-compile"]')].map((li) => li.textContent ?? "");
    expect(chips.map((text) => ["Serving", "Served"].find((word) => text.includes(word)))).toEqual(["Serving", "Served", "Served"]);
  });
});

describe("learning-loop integration with source-owned execution", () => {
  it.each(["claude-code", "codex"] as const)("native %s learning never promises automatic compilation or takeover", async runtime => {
    const native: NonNullable<Agent["definition"]["native"]> = { runtime, model: null, project: "/workspace/app", selector: { kind: "project" as const }, machine_id: "source", version: "1", fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready" as const, issues: [], connected: true, verified_at: "2026-11-12T00:00:00Z", capabilities: { launch: true, learning: true, workflows: false, approval: "native" as const, usage: true } };
    const t = await open(agent(true, { native }));
    const story = t.host.querySelector('[data-testid="loop-story"]')!;
    expect(story.textContent).toContain("Native runs are given your corrections; learned workflows are unavailable.");
    expect(t.text()).toContain("Native run costs");
    expect(t.text()).not.toContain("takes the job over");
    expect(story.textContent).not.toContain("compiles at");
    expect(story.querySelector('[data-testid="stage-took_over"]')).toBeNull();
    expect(story.querySelector('[data-testid="stage-cheaper"]')).toBeNull();
  });
  it.each(["claude-agent-sdk", "codex-sdk", "eve"] as const)("%s keeps launches in the backend and workflows explicitly bound", async runtime => {
    const t = await open(agent(true, { sdk: { runtime } }));
    const story = t.host.querySelector('[data-testid="loop-story"]')!;
    expect(story.textContent).toContain("Your backend keeps launching each run");
    expect(t.text()).toContain("SDK run costs");
    expect(t.text()).not.toContain("takes the job over");
    expect(story.textContent).toContain("MCP with explicitly bound tools");
    expect(story.textContent).not.toContain("serves first");
    expect(story.querySelector('[data-testid="stage-cheaper"]')).toBeNull();
  });
});

describe("learning-loop refresh integration", () => {
  it.each(["loop", "promotions"] as const)("an in-flight %s background read cannot change the snapshot under an open edit", async kind => {
    let release!: () => void;
    let reads = 0;
    const marker = "late-workflow-after-edit";
    const emptyLoop: LearningLoop = { agent: "refunds", completed_runs: 0, compiles: [] };
    const emptyPromotions: Promotions = { agent: "refunds", promotions: [], serving: [] };
    const lateLoop: LearningLoop = { ...emptyLoop, compiles: [{ run_id: "late-run", round: 1, at: "2026-11-05T10:00:00Z", workflow: marker, attempts: [{ ok: false, errors: ["late draft"] }], digest: null, promoted: null, draft_errors: ["late draft"], withheld: false }] };
    const latePromotions: Promotions = { ...emptyPromotions, promotions: [{ workflow: marker, digest: "a".repeat(16), at: "2026-11-05T10:00:00Z", decided: "hold", reason: "late decision" }] };
    const fake: Fake = kind === "loop"
      ? { loop: () => ++reads === 1 ? Promise.resolve(emptyLoop) : new Promise(resolve => { release = () => resolve(lateLoop); }) }
      : { promotions: () => ++reads === 1 ? Promise.resolve(emptyPromotions) : new Promise(resolve => { release = () => resolve(latePromotions); }) };
    const t = await open(agent(true), fake);
    await focus();
    expect(reads).toBe(2);
    await t.click(/^Edit corrections$/);
    const draft = t.editor()!.querySelector("textarea")!;
    await t.type(draft, "Keep this draft and its reviewed snapshot.");
    await act(async () => { release(); }); await settle();
    expect(t.text()).not.toContain(marker);
    expect(draft.value).toBe("Keep this draft and its reviewed snapshot.");
    await t.click(/^Cancel$/);
    await focus();
    await act(async () => { release(); }); await settle();
    expect(t.text()).toContain(marker);
  });
});

describe("the bill", () => {
  it("shows the booked bill against the agent for all of it, the break-even marker and the audit line, and no equal-cache figure", async () => {
    const digest = "d".repeat(16);
    const runs = BILL.points.map((p) => ({ n: p.n, run_id: p.run_id, started_at: hour(p.n), path: p.n < 4 ? "agent" as const : "workflow" as const, workflow: p.n < 4 ? null : "answer", digest: p.n < 4 ? null : digest, took_over: p.n === 4, audited: p.n >= 5, cost_usd: 1, cost_upper_bound: false, learning_usd: 0, total_usd: 1 }));
    const cost: LearningCost = { agent: "refunds", runs, total_runs: runs.length, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: TAKEOVER, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [], bill: BILL };
    const promotions: Promotions = {
      agent: "refunds",
      promotions: [{ workflow: "answer", digest, at: hour(4), decided: "promote", reason: "checked", check: { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1, n: 10, agreed: 9, alone: 9 } }],
      serving: [{ workflow: "answer", digest, replaying: null, state: "serving", check: { n: 10, agreed: 9, alone: 9, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 4, disagreed: 1 }, audits_off: null, not_auditable: 0, champion: null }],
    };
    const audits = [true, true, false, true, true].map((agreed, i) => ({ run: `run-${i + 5}`, shadow_run: `audit.run-${i + 5}`, workflow: "answer", digest, promoted_at: hour(4), source: "shadow" as const, agreed, served_cost: 0.1, shadow_cost: 0.4, at: hour(i + 5) }));
    const t = await open(agent(true), { cost: async () => cost, promotions: async () => promotions, audits });
    expect(t.host.querySelector("[data-testid=bill-actual]")).not.toBeNull();
    expect(t.host.querySelector("[data-testid=bill-agent]")).not.toBeNull();
    expect(t.host.querySelector("[data-testid=bill-break-even]")).not.toBeNull();
    expect(t.text()).toContain("Break-even at run 5");
    expect(t.text()).toContain("Last 4 audits: 3 agreed");
    expect(t.text()).toContain("All time: 4 of 5 agreed");
    // Runs 5 to 9 were audited and each has its row: the card and the charged runs agree, nothing waits.
    expect(t.text()).not.toContain("not scored yet");
    expect(t.text()).not.toMatch(/equal[- ]cache/i);
  });
});
