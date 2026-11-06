import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LearningTab, type LearningProps } from "./Learning";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";
import type { AgentLearning, LearningNote } from "@/lib/learning";
import type { Run } from "@/lib/v2";

// The agent's Learning tab: its notes with where each came from, edit (its version named), retire after a confirm, a
// note a person adds, what runs did not keep and why, the before and after, and the switch.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (learning?: boolean, extra: Partial<Agent["definition"]> = {}): Agent => ({
  agent_id: "refunds", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Refund policy finder", instructions: "Find it.", harness: "pi", skills: [], tools: ["read", "write"], ...(learning === undefined ? {} : { learning }), ...extra },
});
const note = (file: string, name: string, extra: Partial<LearningNote> = {}): LearningNote => ({
  file, name, description: `When ${name.toLowerCase()} applies`, type: "feedback", status: "active", superseded_by: null, runs: { given: 0, read: 0 },
  text: `---\nname: ${name}\ndescription: When ${name.toLowerCase()} applies\ntype: feedback\n---\nThe body of ${name}.\n`, ...extra,
});
const FIRST = "try-policies-refund-policy-first.md";
const OLD = "shopify-refund-policy-path.md";
const MINE = "keep-it-to-three-lines.md";
const view = (extra: Partial<AgentLearning> = {}): AgentLearning => ({
  agent: "refunds", main: "c3", index: `- [Try /policies/refund-policy first](${FIRST}) — Open it first\n- [Keep it to three lines](${MINE}) — Short`,
  notes: { items: [note(MINE, "Keep it to three lines"), note(FIRST, "Try /policies/refund-policy first"), note(OLD, "Shopify refund policy path", { status: "superseded", superseded_by: FIRST })], total: 3, next_cursor: null },
  log: { items: [
    { by: { user: true }, commit: "c3", at: "2026-11-03T16:52:40Z", reason: "created by a person", files: [MINE, "MEMORY.md"] },
    { by: { run: "run-b" }, commit: "c2", at: "2026-11-03T16:52:30Z", reason: "General and new: it holds for other shops too.", files: [OLD, FIRST, "MEMORY.md"] },
    { by: { run: "run-a" }, commit: "c1", at: "2026-11-03T16:52:10Z", reason: "Holds for Shopify stores.", files: [OLD, "MEMORY.md"] },
  ], total: 3, next_cursor: null },
  counts: { merged: 2, dropped: { empty: 2, grader: 1 }, in_progress: 0 },
  ...extra,
});
const runOf = (id: string, title: string, learning: Run["learning"]): Run => ({
  run_id: id, agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-03T16:52:00Z", ended_at: "2026-11-03T16:52:09Z", result: null, error: null, cost: null, archived_at: null, learning,
});
const RUNS: Run[] = [
  runOf("run-e", "everlane.com", { state: "dropped", reason: "empty", read: [{ file: FIRST, name: "Try" }, { file: MINE, name: "Keep" }] }),
  runOf("run-k", "kith.com", { state: "dropped", reason: "grader", detail: "Not kept: It's about one shop's returns portal.", read: [{ file: FIRST, name: "Try" }] }),
  runOf("run-c", "allbirds.com", { state: "dropped", reason: "empty", read: [{ file: FIRST, name: "Try" }] }),
  runOf("run-b", "brooklinen.com", { state: "merged", reason: null, read: [{ file: OLD, name: "Old" }] }),
  runOf("run-p", "patagonia.com", { state: "dropped", reason: "no_budget" }),
  runOf("run-a", "taylorstitch.com", { state: "merged", reason: null }),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

type Fake = { learning?: () => Promise<AgentLearning>; runs?: Run[]; read?: (file: string) => Promise<{ note: string; etag: string | null }>; write?: (file: string, text: string, on: unknown) => Promise<unknown>; retire?: (file: string, etag: string) => Promise<unknown>; approve?: (file: string, etag: string) => Promise<unknown>; restore?: (file: string, etag: string) => Promise<unknown>; caps?: unknown; notes?: (cursor: string) => Promise<{ items: LearningNote[]; total: number; next_cursor: string | null }>; log?: (cursor: string) => Promise<AgentLearning["log"]>; runsNext?: string | null; update?: (body: unknown, etag: string | null) => Promise<{ agent: Agent; etag: string }> };
async function open(a: Agent, fake: Fake = {}, props: Partial<LearningProps> = {}) {
  const calls: string[] = [];
  const agents: Agent[] = [];
  const v2 = {
    agentLearning: async (id: string) => { calls.push(`learning ${id}`); return (fake.learning ?? (async () => view()))(); },
    listAgentRuns: async (id: string) => { calls.push(`runs ${id}`); return { runs: fake.runs ?? RUNS, next_cursor: fake.runsNext ?? null }; },
    readNote: async (_id: string, file: string) => { calls.push(`read ${file}`); return (fake.read ?? (async (f: string) => ({ note: view().notes.items.find((x) => x.file === f)!.text, etag: `"v-${f}"` })))(file); },
    writeNote: async (_id: string, file: string, text: string, on: unknown) => { calls.push(`write ${file} ${JSON.stringify(on)}`); return (fake.write ?? (async () => ({ text, etag: '"v2"' })))(file, text, on); },
    retireNote: async (_id: string, file: string, etag: string) => { calls.push(`retire ${file} ${etag}`); return (fake.retire ?? (async () => ({ text: "", etag: '"v3"' })))(file, etag); },
    approveNote: async (_id: string, file: string, etag: string) => { calls.push(`approve ${file} ${etag}`); return (fake.approve ?? (async () => ({ note: "", etag: '"v4"' })))(file, etag); },
    restoreNote: async (_id: string, file: string, etag: string) => { calls.push(`restore ${file} ${etag}`); return (fake.restore ?? (async () => ({ note: "", etag: '"v5"' })))(file, etag); },
    getAgent: async () => { calls.push("agent"); return { agent: a, etag: '"rv1"' }; },
    updateDefinition: async (_id: string, body: unknown, etag: string | null) => { calls.push(`put ${JSON.stringify(body)} ${etag}`); return (fake.update ?? (async () => ({ agent: { ...a, revision: "rv2", revisions: 2, definition: { ...a.definition, ...(body as { definition: object }).definition } }, etag: '"rv2"' })))(body, etag); },
    learningNotes: async (_id: string, cursor: string) => { calls.push(`notes after ${cursor}`); return (fake.notes ?? (async () => ({ items: [], total: 0, next_cursor: null })))(cursor); },
    learningLog: async (_id: string, cursor: string) => { calls.push(`log after ${cursor}`); return (fake.log ?? (async () => ({ items: [], total: 0, next_cursor: null })))(cursor); },
    capabilities: async () => { calls.push("capabilities"); return fake.caps ?? {}; },
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
  return { host, calls, agents, button, click, card, type, key, text: () => host.textContent ?? "" };
}

describe("the Learning tab's notes", () => {
  it("tells apart two runs started in the same second that learned notes, when it has no title for them", async () => {
    // UUIDv7s from the same millisecond: the same leading digits, different random tails.
    const [A, B] = ["01a1a869-ce4e-7cf5-abf8-c5407893934a", "01a1a869-ce4e-7d11-9a02-3f6b0e21d7c5"];
    const log: AgentLearning["log"] = { items: [
      { by: { run: B }, commit: "c2", at: "2026-11-04T21:14:01Z", reason: "Kept.", files: [MINE, "MEMORY.md"] },
      { by: { run: A }, commit: "c1", at: "2026-11-04T21:14:00Z", reason: "Kept.", files: [FIRST, "MEMORY.md"] },
    ], total: 2, next_cursor: null };
    const t = await open(agent(true), { learning: async () => view({ log }), runs: [] });
    const label = (name: string, id: string) => t.card(name)!.querySelector(`a[href="#/runs/${id}"]`)?.textContent ?? "";
    const [a, b] = [label("Try /policies/refund-policy first", A), label("Keep it to three lines", B)];
    expect(a).toMatch(/^run \S+$/);
    expect(b).toMatch(/^run \S+$/);
    expect(a).not.toBe(b);
  });
  it("shows each note in use with its type, its body, the run that learned it and how many runs it was given to and read in", async () => {
    // The server names the person's note's newest change (last_change): created by them.
    const v = view();
    v.notes.items = v.notes.items.map((x) => (x.file === MINE ? { ...x, last_change: { kind: "created" as const, by: "person" as const, at: "2026-11-03T16:52:40Z" }, runs: { given: 2, read: 1 } } : x.file === FIRST ? { ...x, runs: { given: 3, read: 3 } } : x));
    const t = await open(agent(true), { learning: async () => v });
    expect(t.text()).toContain("What it has learned");
    expect(t.text()).toContain("2 notes in use. Every later run reads them before it starts.");
    const first = t.card("Try /policies/refund-policy first")!;
    // The type in plain words, the API's value in its tooltip.
    expect(first.textContent).toContain("How to work");
    expect(first.querySelector('[title="feedback"]')).toBeNull();
    expect(first.textContent).toContain("The body of Try /policies/refund-policy first.");
    expect(first.textContent).toContain("Learned in");
    expect(first.querySelector('a[href="#/runs/run-b"]')?.textContent).toBe("brooklinen.com");
    expect(first.textContent).toContain("Given to 3 runs");
    expect(first.textContent).toContain("Read in 3 runs");
    const mine = t.card("Keep it to three lines")!;
    expect(mine.textContent).toMatch(/Created by you · \S/);
    expect(mine.textContent).toContain("Given to 2 runs");
    expect(mine.textContent).toContain("Read in 1 run");
  });
  it("one note in use is said as one: it, not them", async () => {
    const one = view();
    one.notes.items = one.notes.items.filter((x) => x.file !== MINE);
    one.index = `- [Try /policies/refund-policy first](${FIRST}) — Open it first\n`;
    const t = await open(agent(true), { learning: async () => one });
    expect(t.text()).toContain("1 note in use. Every later run reads it before it starts.");
    expect(t.text()).toContain("What the next run reads1 note");
  });
  it("a note no run has opened says only how many runs it was given to", async () => {
    const t = await open(agent(true));
    expect(t.card("Keep it to three lines")!.textContent).toContain("Given to 0 runs");
    expect(t.text()).not.toContain("Read in");
  });
  it("keeps a replaced note out of the list, under Earlier notes, naming what replaced it", async () => {
    const t = await open(agent(true));
    expect(t.card("Shopify refund policy path")).toBeNull();
    expect(t.text()).toContain("Earlier notes1 no longer read");
    await t.click(/^Earlier notes/);
    expect(t.text()).toContain("Replaced by Try /policies/refund-policy first");
    // A button, not a link: the address is the page's router. It moves the focus to the note that replaced it.
    const to = [...t.host.querySelectorAll('section[aria-label="Earlier notes"] button')].find((b) => b.textContent === "Try /policies/refund-policy first")!;
    await act(async () => { (to as HTMLButtonElement).click(); });
    expect(document.activeElement).toBe(t.card("Try /policies/refund-policy first"));
  });
  it("a note an address points at is highlighted, and an earlier one opens its list", async () => {
    const t = await open(agent(true), {}, { focus: [FIRST, OLD] });
    const lit = (name: string) => t.card(name)!.className.split(/\s+/).includes("border-primary");
    expect(lit("Try /policies/refund-policy first")).toBe(true);
    expect(lit("Keep it to three lines")).toBe(false);
    expect(t.text()).toContain("Replaced by");
  });
  it("what the next run reads is the server's index, read-only, behind a toggle", async () => {
    const t = await open(agent(true));
    expect(t.text()).toContain("What the next run reads2 notes");
    expect(t.text()).not.toMatch(/\d lines?\b/);
    await t.click(/^What the next run reads/);
    expect(t.host.querySelector("pre")?.textContent).toContain(`(${FIRST})`);
    expect(t.text()).toContain("Read-only");
  });
  it("says nothing in git's or the loop's own words", async () => {
    const t = await open(agent(true));
    await t.click(/^Earlier notes/);
    await t.click(/^What the next run reads/);
    const shown = t.text().replace(/\(.*?\.md\)/g, "");
    expect(shown).not.toMatch(/\b(main|merge|merged|commit|grader|verdict|proposal|proposed|end-of-run|reflect|seed)\b/i);
  });
});

describe("what runs did not keep", () => {
  it("lists a refused note and a skip with their words, newest first, and counts the runs with nothing new", async () => {
    const t = await open(agent(true));
    const list = t.host.querySelector('section[aria-label="Kept nothing"]')!;
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    // The server's sentence as it is, under a title that does not say "Not kept" again.
    expect(rows[0]).toContain("Not kept: It's about one shop's returns portal.");
    expect(rows[0]).toContain("kith.com");
    expect(rows[1]).toContain("Skipped: no budget left in this run to look back.");
    expect(rows).toHaveLength(2);
    expect(list.textContent).toContain("2 more runs had nothing new to remember.");
  });
  it("a run with no sentence says the reason in the console's words", async () => {
    const t = await open(agent(true), { runs: [runOf("run-k", "kith.com", { state: "dropped", reason: "grader" })] });
    expect(t.host.querySelector('section[aria-label="Kept nothing"]')!.textContent).toContain("Not kept: it wouldn't help later runs enough.");
  });
});

describe("the before and after", () => {
  it("shows run time and cost before and after it learned, on the after side's runs", async () => {
    const t = await open(agent(true), { learning: async () => view({ impact: { before: { runs: 2, median_duration_s: 18, median_cost_usd: 0.11 }, after: { runs: 4, median_duration_s: 12, median_cost_usd: 0.03 } } }) });
    const card = t.host.querySelector('section[aria-label^="Since it learned"]')!;
    expect(card.getAttribute("aria-label")).toBe("Since it learned (on 4 runs): answers in 12s instead of 18s · $0.03 est. instead of $0.11 est. a run");
    expect(card.textContent).toContain("Answers in12sinstead of 18s−33%");
    expect(card.textContent).toContain("A run costs$0.03 est.instead of $0.11 est.−73%");
    expect(card.textContent).toContain("on 4 runs");
    expect(card.textContent).not.toContain("Learning itself");
  });
  it("says what learning itself costs a run when the server does, and a costlier after as it is, in the warning colour", async () => {
    const t = await open(agent(true), { learning: async () => view({ impact: { before: { runs: 2, median_duration_s: 1.2, median_cost_usd: 0.000814, cost_runs: 2 }, after: { runs: 4, median_duration_s: 1.1, median_cost_usd: 0.000837, cost_runs: 4, median_learning_usd: 0.008 } } }) });
    const card = t.host.querySelector('section[aria-label^="Since it learned"]')!;
    expect(card.textContent).toContain("Learning itself$0.0080 est. a run");
    const up = [...card.querySelectorAll("span")].find((x) => x.textContent === "+3%")!;
    expect(up.className).toContain("text-warning-text");
    expect(card.querySelector('[title^="Medians of 2 runs"]')?.getAttribute("title")).toContain("Costs are of the 2 and 4 runs whose cost is known.");
  });
  it("is hidden when the server has none, or an older server says nothing", async () => {
    for (const impact of [null, undefined]) {
      const t = await open(agent(true), { learning: async () => view({ impact }) });
      expect(t.host.querySelector('section[aria-label^="Since it learned"]')).toBeNull();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
  it("until there is one, one quiet line says when it will show; an older server, which has none to give, says nothing", async () => {
    const LINE = "After two runs on each side of its first note, this shows what learning changed.";
    const t = await open(agent(true), { learning: async () => view({ impact: null }) });
    expect(t.text()).toContain(LINE);
    expect(t.host.querySelectorAll("p").length).toBeGreaterThan(0);
    expect([...t.host.querySelectorAll("p")].filter((x) => x.textContent === LINE)).toHaveLength(1);
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect((await open(agent(true), { learning: async () => view({ impact: undefined }) })).text()).not.toContain(LINE);
    act(() => root?.unmount()); document.body.innerHTML = "";
    // With learning off, no run will fill it: nothing is promised.
    expect((await open(agent(false), { learning: async () => view({ impact: null }) })).text()).not.toContain(LINE);
  });
});

describe("editing a note", () => {
  it("opens it as fields read with its version, and Ctrl+Enter saves the whole text on that version", async () => {
    const t = await open(agent(true));
    await t.click(/^Edit Try/);
    expect(t.calls).toContain(`read ${FIRST}`);
    const editor = t.host.querySelector('section[aria-label="Edit note"]')!;
    const [name, description] = [...editor.querySelectorAll("input:not([type=radio])")] as HTMLInputElement[];
    expect([...editor.querySelectorAll('[role="radiogroup"] label')].map((l) => `${l.textContent}=${l.getAttribute("title")}`)).toEqual(["How to work=feedback", "About the work=project", "Where to look=reference", "About you=user"]);
    expect(name.value).toBe("Try /policies/refund-policy first");
    expect(description.value).toBe("When try /policies/refund-policy first applies");
    const body = editor.querySelector("textarea")!;
    expect(body.value).toBe("The body of Try /policies/refund-policy first.\n");
    await t.type(body, "Open /policies/refund-policy before anything else.\n");
    await t.key(body, "Enter", { ctrlKey: true });
    const write = t.calls.find((c) => c.startsWith(`write ${FIRST}`))!;
    expect(write).toBe(`write ${FIRST} {"etag":"\\"v-${FIRST}\\""}`);
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
    expect(t.host.querySelector('section[aria-label="Edit note"]')).toBeNull();
    expect(t.card("Try /policies/refund-policy first")!.textContent).toContain("Saved");
  });
  it("opens on the version the card showed; one changed since opens on its newest, and says so", async () => {
    const t = await open(agent(true), { read: async () => ({ note: "---\nname: Try /policies/refund-policy first\ndescription: d\ntype: feedback\n---\nThe newer body.\n", etag: '"v7"' }) });
    await t.click(/^Edit Try/);
    expect(t.text()).toContain("This is the newest version, not the one the card showed.");
    expect((t.host.querySelector('section[aria-label="Edit note"] textarea') as HTMLTextAreaElement).value).toBe("The newer body.\n");
    await t.key(t.host.querySelector('section[aria-label="Edit note"] textarea')!, "Enter", { ctrlKey: true });
    expect(t.calls).toContain(`write ${FIRST} {"etag":"\\"v7\\""}`);
  });
  it("from a server whose notes carry their version, opens on the card's text and version with no read", async () => {
    const withTags = view();
    withTags.notes.items = withTags.notes.items.map((x) => ({ ...x, etag: `"card-${x.file}"` }));
    const t = await open(agent(true), { learning: async () => withTags });
    await t.click(/^Edit Try/);
    expect(t.calls.some((c) => c.startsWith("read"))).toBe(false);
    await t.key(t.host.querySelector('section[aria-label="Edit note"] textarea')!, "Enter", { ctrlKey: true });
    expect(t.calls).toContain(`write ${FIRST} {"etag":"\\"card-${FIRST}\\""}`);
  });
  it("never saves with no version: no empty If-Match is sent", async () => {
    const t = await open(agent(true), { read: async (f) => ({ note: view().notes.items.find((x) => x.file === f)!.text, etag: null }) });
    await t.click(/^Edit Try/);
    await t.click(/^Save$/);
    expect(t.text()).toContain("Not saved: Can't tell which version this is: reload.");
    expect(t.calls.some((c) => c.startsWith("write"))).toBe(false);
  });
  it("Enter in a one-line field saves too, and Esc cancels without a write", async () => {
    const t = await open(agent(true));
    await t.click(/^Edit Keep/);
    const name = t.host.querySelector('section[aria-label="Edit note"] input') as HTMLInputElement;
    await t.key(name, "Escape");
    expect(t.host.querySelector('section[aria-label="Edit note"]')).toBeNull();
    expect(t.calls.some((c) => c.startsWith("write"))).toBe(false);
    await t.click(/^Edit Keep/);
    await t.key(t.host.querySelector('section[aria-label="Edit note"] input')!, "Enter");
    expect(t.calls.some((c) => c.startsWith(`write ${MINE}`))).toBe(true);
  });
  it("a note changed since it was opened is not written over: it says so, loads the newest and keeps the edit to copy", async () => {
    let reads = 0;
    const t = await open(agent(true), {
      read: async () => ({ note: `---\nname: Try it first\ndescription: d\ntype: feedback\n---\n${reads++ ? "The newest body.\n" : "The old body.\n"}`, etag: `"v${reads}"` }),
      write: async () => { throw new ClientError(412, "precondition_failed", "The note changed since it was read."); },
    });
    await t.click(/^Edit Try/);
    const body = () => t.host.querySelector('section[aria-label="Edit note"] textarea') as HTMLTextAreaElement;
    await t.type(body(), "My edit.\n");
    await t.click(/^Save$/);
    expect(t.text()).toContain("Changed since you opened it");
    expect(t.text()).toContain("This is the newest version. Your edit wasn't saved; it's below to copy.");
    expect(body().value).toBe("The newest body.\n");
    expect(t.host.querySelector('section[aria-label="Edit note"] pre')!.textContent).toContain("My edit.");
  });
  it("a note the checks refuse lists why, and is not closed", async () => {
    const t = await open(agent(true), { write: async () => { throw Object.assign(new ClientError(400, "bad_request", "The note does not pass the checks: secret_value."), { problems: [{ rule: "secret_value", path: FIRST, detail: "it holds the value of one of this server's secrets" }] }); } });
    await t.click(/^Edit Try/);
    await t.click(/^Save$/);
    expect(t.text()).toContain("Not saved: the note doesn't pass the checks.");
    expect(t.text()).toContain("it holds the value of one of this server's secrets");
    expect(t.host.querySelector('section[aria-label="Edit note"]')).not.toBeNull();
  });
  it("a person adds a note: its file from its name, created only if the name is free", async () => {
    const t = await open(agent(true));
    await t.click(/^Add a note$/);
    const editor = t.host.querySelector('section[aria-label="New note"]')!;
    const [name, description] = [...editor.querySelectorAll("input:not([type=radio])")];
    expect(t.button(/^Add note$/)!.disabled).toBe(true);
    await t.type(name, "Prices in the shop's currency");
    await t.type(description, "Quote fees as the policy writes them");
    await t.type(editor.querySelector("textarea")!, "Never convert.\n");
    await t.click(/^Add note$/);
    expect(t.calls).toContain('write prices-in-the-shop-s-currency.md {"create":true}');
  });
  it("a note added to an agent with none, whose refresh then fails, says so over the empty state; Try again shows it", async () => {
    let reads = 0;
    const none = () => view({ index: "", notes: { items: [], total: 0, next_cursor: null } });
    const added = () => view({ notes: { items: [note("prices-in-the-shop-s-currency.md", "Prices in the shop's currency")], total: 1, next_cursor: null } });
    const t = await open(agent(true), { learning: async () => { reads++; if (reads === 2) throw new TypeError("Failed to fetch"); return reads === 1 ? none() : added(); } });
    await t.click(/^Or write a note yourself$/);
    const editor = t.host.querySelector('section[aria-label="New note"]')!;
    const [name, description] = [...editor.querySelectorAll("input:not([type=radio])")];
    await t.type(name, "Prices in the shop's currency");
    await t.type(description, "Quote fees as the policy writes them");
    await t.type(editor.querySelector("textarea")!, "Never convert.\n");
    await t.click(/^Add note$/);
    expect(reads).toBe(2);
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't refresh the notes: can't reach agentrun-serve. What's shown may be out of date.");
    await t.click(/^Try again$/);
    expect(t.card("Prices in the shop's currency")).toBeTruthy();
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("retiring a note", () => {
  it("asks first, in plain words; Keep or Esc leaves it, and Retire retires it on the version read", async () => {
    const t = await open(agent(true));
    await t.click(/^Retire Keep/);
    const dialog = t.host.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Retire it? Later runs stop reading it. It stays under Earlier notes.");
    expect(document.activeElement?.textContent).toBe("Yes, retire");
    await t.key(dialog, "Escape");
    expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.calls).toContain(`retire ${MINE} "v-${MINE}"`);
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
  });
  it("is made on the version the card showed: a note whose text changed since says so, and is not retired", async () => {
    const t = await open(agent(true), { read: async () => ({ note: "---\nname: Keep it to three lines\ndescription: d\ntype: feedback\n---\nSomeone changed this.\n", etag: '"v9"' }) });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.text()).toContain("It changed since you opened it. Reload the tab to see the newest version.");
    expect(t.calls.some((c) => c.startsWith("retire"))).toBe(false);
  });
  it("from a server whose notes carry their version, retires on the card's own, with no read", async () => {
    const withTags = view();
    withTags.notes.items = withTags.notes.items.map((x) => ({ ...x, etag: `"card-${x.file}"` }));
    const t = await open(agent(true), { learning: async () => withTags });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.calls).toContain(`retire ${MINE} "card-${MINE}"`);
    expect(t.calls.some((c) => c.startsWith("read"))).toBe(false);
  });
  it("never retires with no version: a read that names none says so", async () => {
    const t = await open(agent(true), { read: async (f) => ({ note: view().notes.items.find((x) => x.file === f)!.text, etag: null }) });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.text()).toContain("Can't tell which version this is: reload.");
    expect(t.calls.some((c) => c.startsWith("retire"))).toBe(false);
  });
  it("one changed between the read and the retire says so, and is not retired", async () => {
    const t = await open(agent(true), { retire: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.text()).toContain("It changed since you opened it.");
  });
  it("a refresh that fails after a retire says so beside the notes still shown, and Try again reads them again", async () => {
    let reads = 0;
    const retired = () => { const v = view(); v.notes.items = v.notes.items.map((x) => (x.file === MINE ? { ...x, status: "retired" as const } : x)); return v; };
    const t = await open(agent(true), { learning: async () => { reads++; if (reads === 2) throw new ClientError(503, "unavailable", "The server is restarting."); return reads === 1 ? view() : retired(); } });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(reads).toBe(2);
    // The notes read before stay, with a line that says they were not read again, and why.
    expect(t.card("Keep it to three lines")).toBeTruthy();
    const line = t.host.querySelector('section[aria-label="Notes"] [role="alert"]');
    expect(line, "a line beside the notes that says the refresh failed").not.toBeNull();
    expect(line!.textContent).toContain("Couldn't refresh the notes: the server is busy.");
    expect(line!.textContent).toContain("What's shown may be out of date.");
    await t.click(/^Try again$/);
    expect(reads).toBe(3);
    expect(t.text()).not.toContain("Couldn't refresh the notes");
    expect(t.text()).toContain("1 note in use.");
  });
});

describe("the switch and the empty states", () => {
  it("with no note and learning off: one sentence on what learning is, and the switch, which saves a revision with learning on", async () => {
    const off = agent(undefined);
    const t = await open(off, { learning: async () => view({ main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, log: { items: [], total: 0, next_cursor: null } }), runs: [] });
    expect(t.text()).toContain("Learning is off for this agent.");
    expect(t.text()).toContain("With learning on, it keeps short notes on what worked after each run, and every later run reads them before it starts.");
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
    const t = await open(agent(undefined), { learning: async () => view({ notes: { items: [], total: 0, next_cursor: null } }), runs: [], update: async () => { throw new ClientError(412, "precondition_failed", "Another revision was saved first."); } });
    const sw = t.host.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    await settle();
    expect(t.text()).toContain("Learning was not changed.");
    expect(t.text()).toContain("Another revision was saved first. · precondition_failed");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
  it("with learning on and nothing learned yet: says so, and how many runs looked back", async () => {
    const t = await open(agent(true), { learning: async () => view({ notes: { items: [], total: 0, next_cursor: null } }), runs: [RUNS[0], RUNS[2]] });
    expect(t.text()).toContain("Nothing learned yet");
    expect(t.text()).toContain("2 runs looked back: nothing worth keeping yet.");
    expect(t.text()).toContain("Or write a note yourself");
  });
  it("learning on without the write tool asks for no tool: the switch is on, with no line about one and no Add it", async () => {
    const t = await open(agent(true, { tools: ["read"] }));
    expect((t.host.querySelector('[role="switch"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(t.text()).not.toMatch(/write tool/i);
    expect([...t.host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Add it");
  });
  it("notes kept while learning is off say later runs don't read them", async () => {
    const t = await open(agent(false));
    expect(t.text()).toContain("Learning is off, so later runs don't read these notes.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const t2 = await open(agent(true), {}, { server: "off" });
    expect(t2.text()).toContain("This server has learning turned off");
  });
  it("an archived agent's notes are shown, and nothing offers to change them", async () => {
    const t = await open({ ...agent(true), archived_at: "2026-11-03T17:00:00Z" });
    expect(t.card("Try /policies/refund-policy first")).not.toBeNull();
    expect(t.button(/^Edit /)).toBeUndefined();
    expect(t.button(/^Add a note$/)).toBeUndefined();
    expect((t.host.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("loading and errors", () => {
  it("shows placeholders while it reads, then the notes", async () => {
    let release!: (v: AgentLearning) => void;
    const t = await open(agent(true), { learning: () => new Promise((r) => { release = r; }) });
    const loading = t.host.querySelector('[aria-busy="true"]')!;
    expect([loading.getAttribute("role"), loading.getAttribute("aria-label")]).toEqual(["status", "Loading what it learned"]);
    expect(loading.innerHTML).toContain("motion-safe:animate-pulse");
    expect(loading.innerHTML).not.toMatch(/(^|[\s"])animate-pulse/);
    await act(async () => { release(view()); });
    await settle();
    expect(t.text()).toContain("What it has learned");
  });
  it("a failed read says so with the server's message, and reads again on Try again", async () => {
    let n = 0;
    const t = await open(agent(true), { learning: async () => { if (n++ === 0) throw new ClientError(500, "internal", "The agent's notes could not be read."); return view(); } });
    expect(t.text()).toContain("What this agent learned could not be read.");
    expect(t.text()).toContain("The server hit a problem on its side.");
    expect(t.text()).toContain("The agent's notes could not be read. · internal");
    await t.click(/Try again/);
    expect(t.text()).toContain("What it has learned");
  });
});

describe("notes that wait for the owner's OK", () => {
  const TRUST = "trust-acme-refunds.md";
  const waitingView = () => {
    const v = view();
    v.notes.items = [
      note(TRUST, "Trust acme.com's refund page", { status: "pending", etag: '"card-trust"', text: "---\nname: Trust acme.com's refund page\ndescription: d\ntype: feedback\norigin: you\n---\nTrust it.\n" }),
      ...v.notes.items.map((x) => ({ ...x, etag: `"card-${x.file}"` })),
    ];
    return v;
  };
  const APPROVES = { learning: { pending: true, approve: true } };
  // The host's bash runs as you only off the sandbox: an agent whose definition places it in a box is told nothing of it.
  it("say a run's bash on the host runs as you only for an agent that runs on the host, not one in the sandbox", async () => {
    const HOST = "Runs that use bash on the host run as you.";
    const boxed = await open(agent(true, { place: { mode: "sandbox", box: "docker" } } as never), { learning: async () => waitingView(), caps: APPROVES });
    expect(boxed.host.querySelector('section[aria-label="Waiting for your OK"]')!.textContent).not.toContain(HOST);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const runner = await open(agent(true, { place: { mode: "runner" } } as never), { learning: async () => waitingView(), caps: APPROVES });
    expect(runner.host.querySelector('section[aria-label="Waiting for your OK"]')!.textContent).toContain(HOST);
  });
  // An agent that names no place runs where the server's default place is (#1790): in its box, no word of the host's bash;
  // on the runner (the default, or a runner-only tool), the word stays.
  it("say the host's bash runs as you for an agent with no place only where the server's default runs it on the host", async () => {
    const HOST = "Runs that use bash on the host run as you.";
    const places = (defaultPlace: NonNullable<LearningProps["places"]>["defaultPlace"]) => ({ modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }], defaultPlace });
    const waiting = () => document.querySelector('section[aria-label="Waiting for your OK"]')!.textContent;
    await open(agent(true), { learning: async () => waitingView(), caps: APPROVES }, { places: places({ mode: "sandbox", box: "docker" }) });
    expect(waiting()).toContain("It changes what this agent trusts or skips");
    expect(waiting()).not.toContain(HOST);
    act(() => root?.unmount()); document.body.innerHTML = "";
    await open(agent(true), { learning: async () => waitingView(), caps: APPROVES }, { places: places({ mode: "runner" }) });
    expect(waiting()).toContain(HOST);
    act(() => root?.unmount()); document.body.innerHTML = "";
    await open(agent(true, { tools: ["browser"] } as never), { learning: async () => waitingView(), caps: APPROVES }, { places: places({ mode: "sandbox", box: "docker" }) });
    expect(waiting()).toContain(HOST);
  });
  it("sit at the top of the tab, under why they wait, and out of the notes in use", async () => {
    const t = await open(agent(true), { learning: async () => waitingView(), caps: APPROVES });
    const box = t.host.querySelector('section[aria-label="Waiting for your OK"]')!;
    expect(box).not.toBeNull();
    expect(t.host.querySelector("section, article")).toBe(box);
    expect(box.textContent).toContain("It changes what this agent trusts or skips, so it waits for you.");
    expect(box.textContent).toContain("Runs that use bash on the host run as you. For untrusted tasks, use the sandbox.");
    expect(box.querySelector(`article[aria-label="Trust acme.com's refund page"]`)).not.toBeNull();
    expect(t.text()).toContain("2 notes in use.");
    expect(box.textContent).toContain("From you");
    // A note that waits was given to no run yet, and its footer says so.
    expect(box.querySelector("article footer")?.textContent).toContain("Given to 0 runs");
  });
  it("on a server that approves from the console, Approve is one click, on the card's own version; Retire is there too", async () => {
    const t = await open(agent(true), { learning: async () => waitingView(), caps: APPROVES });
    expect(t.text()).not.toContain("Approving here comes in the next update");
    expect(t.button(/^Retire Trust/)).toBeTruthy();
    expect(t.button(/^Edit Trust/)).toBeUndefined();
    await t.click(/^Approve Trust/);
    expect(t.calls).toContain(`approve ${TRUST} "card-trust"`);
    expect(t.calls.some((c) => c.startsWith("read"))).toBe(false);
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
  });
  it("one changed since its card was read says so, and is not approved", async () => {
    const t = await open(agent(true), { learning: async () => waitingView(), caps: APPROVES, approve: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
    await t.click(/^Approve Trust/);
    expect(t.text()).toContain("It changed since you opened it. Reload the tab to see the newest version.");
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(1);
  });
  it("on a server that holds them but cannot approve from the console yet, there is no Approve: Retire, and a quiet line why", async () => {
    for (const caps of [{ learning: { pending: true } }, {}]) {
      const t = await open(agent(true), { learning: async () => waitingView(), caps });
      const box = t.host.querySelector('section[aria-label="Waiting for your OK"]')!;
      expect(box).not.toBeNull();
      expect(t.button(/^Approve /)).toBeUndefined();
      expect(t.button(/^Retire Trust/)).toBeTruthy();
      expect(box.textContent).toContain("Approving here comes in the next update; until then it stays out of every run.");
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
  it("on a server that approves only from the owner's password sign-in, a caller without one sees why, and no Approve", async () => {
    const t = await open(agent(true), { learning: async () => waitingView(), caps: { learning: { pending: true, approve: false, approve_needs: "password" } } });
    const box = t.host.querySelector('section[aria-label="Waiting for your OK"]')!;
    expect(t.button(/^Approve /)).toBeUndefined();
    expect(t.button(/^Retire Trust/)).toBeTruthy();
    expect(box.textContent).toContain("Approving needs your password sign-in. Until then it stays out of every run.");
    expect(box.textContent).not.toContain("Approving here comes in the next update");
  });
  it("an approve that landed, then a re-read that failed, leaves Approve usable again, never stuck on Approving", async () => {
    let n = 0;
    const t = await open(agent(true), { learning: async () => { if (n++ === 1) throw new ClientError(503, "unavailable", "The server is restarting."); return waitingView(); }, caps: APPROVES });
    await t.click(/^Approve Trust/);
    expect(t.calls).toContain(`approve ${TRUST} "card-trust"`);
    expect(n).toBe(2);
    expect(t.text()).toContain("Couldn't refresh the notes");
    const again = t.button(/^Approve Trust/) as HTMLButtonElement;
    expect(again.textContent).toBe("Approve");
    expect(again.disabled).toBe(false);
  });
  it("there is no such section when no note waits, and the capabilities are not even read", async () => {
    const t = await open(agent(true), { caps: APPROVES });
    expect(t.host.querySelector('section[aria-label="Waiting for your OK"]')).toBeNull();
    expect(t.button(/^Approve /)).toBeUndefined();
    expect(t.calls).not.toContain("capabilities");
  });
});

describe("pages past the first", () => {
  const DEEP = "deep-note.md";
  const paged = (extra: Partial<AgentLearning> = {}) => { const v = view(extra); v.notes = { ...v.notes, total: 4, next_cursor: "n1" }; return v; };
  it("a page asked for before a refresh never lands after it: no old notes, no old cursor", async () => {
    let release!: (p: { items: LearningNote[]; total: number; next_cursor: string | null }) => void;
    let reads = 0;
    const t = await open(agent(true), {
      learning: async () => (reads++ === 0 ? paged() : view()),
      notes: () => new Promise((r) => { release = r; }),
    });
    await t.click(/^Load more notes$/);
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(reads).toBe(2);
    await act(async () => { release({ items: [note("stale.md", "Stale note")], total: 4, next_cursor: "n2" }); });
    await settle();
    expect(t.card("Stale note")).toBeNull();
    expect(t.button(/^Load more notes$/)).toBeUndefined();
  });
  it("a run's link to a note past the first page reads pages until it shows it, highlighted", async () => {
    const t = await open(agent(true), { learning: async () => paged(), notes: async () => ({ items: [note(DEEP, "A deep note")], total: 4, next_cursor: null }) }, { focus: [DEEP] });
    expect(t.calls).toContain("notes after n1");
    expect(t.card("A deep note")!.className.split(/\s+/)).toContain("border-primary");
  });
  it("one that was replaced opens Earlier notes once its page arrives", async () => {
    const t = await open(agent(true), { learning: async () => paged(), notes: async () => ({ items: [note(DEEP, "A deep note", { status: "superseded", superseded_by: FIRST })], total: 4, next_cursor: null }) }, { focus: [DEEP] });
    expect(t.host.querySelector('section[aria-label="Earlier notes"]')!.textContent).toContain("A deep note");
  });
  it("a note's source past the first page of changes is read from the next ones", async () => {
    const v = view();
    v.notes.items = [...v.notes.items, note("older.md", "An older note")];
    v.log = { ...v.log, next_cursor: "l1" };
    const t = await open(agent(true), {
      learning: async () => v,
      runs: [...RUNS, runOf("run-z", "rei.com", { state: "merged", reason: null })],
      log: async () => ({ items: [{ by: { run: "run-z" }, commit: "c0", at: "2026-11-03T15:00:00Z", reason: "General.", files: ["older.md", "MEMORY.md"] }], total: 4, next_cursor: null }),
    });
    expect(t.calls).toContain("log after l1");
    expect(t.card("An older note")!.querySelector('a[href="#/runs/run-z"]')?.textContent).toBe("rei.com");
  });
  it("a page that fails says so; a good Try again clears it, and a linked note's pages are read on", async () => {
    let pages = 0;
    const t = await open(agent(true), {
      learning: async () => paged(),
      notes: async (cursor) => {
        if (pages++ === 0) throw new ClientError(503, "unavailable", "The server is restarting.");
        return cursor === "n1" ? { items: [note("middle-note.md", "A middle note")], total: 5, next_cursor: "n2" } : { items: [note(DEEP, "A deep note")], total: 5, next_cursor: null };
      },
    }, { focus: [DEEP] });
    expect(t.text()).toContain("More notes could not be read.");
    expect(t.calls.filter((c) => c.startsWith("notes after"))).toEqual(["notes after n1"]);
    await t.click(/^Try again$/);
    expect(t.text()).not.toContain("More notes could not be read.");
    expect(t.calls.filter((c) => c.startsWith("notes after"))).toEqual(["notes after n1", "notes after n1", "notes after n2"]);
    expect(t.card("A deep note")!.className.split(/\s+/)).toContain("border-primary");
  });
});

describe("the Learning tab's skills and workflows", () => {
  const SKILL_FILE = "skills/find-policies/SKILL.md";
  const DRAFT_FILE = "workflows/check-refunds/workflow.json";
  const README_FILE = "workflows/check-refunds/README.md";
  const SKILL_TEXT = "---\nname: find-policies\ndescription: Find a store's policies\n---\n# Find policies\n\n1. Open the policies page first.\n";
  const learned = (status: { skill?: "active" | "pending" | "retired"; workflow?: "active" | "pending" | "retired" } = {}) => view({
    skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: status.skill ?? "active", run: "run-b", bytes: 92, etag: '"skill-v1"' }],
    workflows: [{ name: "check-refunds", file: DRAFT_FILE, readme: README_FILE, description: "Checks a store's refund window", status: status.workflow ?? "active", run: "run-a", bytes: 640, etag: '"readme-v1"' }],
  } as Partial<AgentLearning>);
  const reads = async (file: string) => ({ note: file === SKILL_FILE ? SKILL_TEXT : '{"v": 2, "name": "check-refunds"}\n', etag: `"v-${file}"` });

  it("lists the skills and the workflows it learned beside the notes: name, description and the run that kept each, opening to its text", async () => {
    const t = await open(agent(true), { learning: async () => learned(), read: reads });
    const skills = t.host.querySelector('section[aria-label="Skills it learned"]') as HTMLElement;
    const workflows = t.host.querySelector('section[aria-label="Workflows it learned"]') as HTMLElement;
    expect(skills?.textContent).toContain("Skills it learned");
    expect(workflows?.textContent).toContain("Workflows it learned");
    const skill = t.card("find-policies")!;
    expect(skills.contains(skill)).toBe(true);
    expect(skill.textContent).toContain("Find a store's policies");
    expect(skill.textContent).toContain("Learned in");
    expect(skill.querySelector('a[href="#/runs/run-b"]')?.textContent).toBe("brooklinen.com");
    const flow = t.card("check-refunds")!;
    expect(workflows.contains(flow)).toBe(true);
    expect(flow.querySelector('a[href="#/runs/run-a"]')?.textContent).toBe("taylorstitch.com");
    // Its text, read when opened.
    expect(t.calls.some((c) => c.startsWith(`read ${SKILL_FILE}`))).toBe(false);
    await t.click(/^Show the skill find-policies$/);
    expect(t.calls).toContain(`read ${SKILL_FILE}`);
    expect(skill.textContent).toContain("Open the policies page first.");
    await t.click(/^Show the workflow check-refunds$/);
    expect(t.calls).toContain(`read ${DRAFT_FILE}`);
    expect(flow.textContent).toContain('"name": "check-refunds"');
    // No edit: a skill or a workflow is a run's to change; a person approves or retires it.
    expect(t.button(/^Edit find-policies$/)).toBeUndefined();
    expect(t.button(/^Edit check-refunds$/)).toBeUndefined();
  });

  it("an agent with none shows neither section, and an older server's answer without them breaks nothing", async () => {
    const t = await open(agent(true));
    expect(t.host.querySelector('section[aria-label="Skills it learned"]')).toBeNull();
    expect(t.host.querySelector('section[aria-label="Workflows it learned"]')).toBeNull();
    expect(t.text()).toContain("What it has learned");
  });

  it("one that waits for the owner's OK says so, and on a server that approves from the console Approve is one click on its version: a skill's SKILL.md, a workflow's README", async () => {
    const t = await open(agent(true), { learning: async () => learned({ skill: "pending", workflow: "pending" }), caps: { learning: { pending: true, approve: true } } });
    expect(t.calls).toContain("capabilities");
    const skill = t.card("find-policies")!;
    expect(skill.textContent).toContain("Waits for your OK");
    await t.click(/^Approve find-policies$/);
    expect(t.calls).toContain(`approve ${SKILL_FILE} "skill-v1"`);
    await t.click(/^Approve check-refunds$/);
    expect(t.calls).toContain(`approve ${README_FILE} "readme-v1"`);
  });

  it("approving a skill that is open approves the version it shows: the one read when it opened, never a newer one the list holds", async () => {
    const t = await open(agent(true), { learning: async () => learned({ skill: "pending" }), caps: { learning: { pending: true, approve: true } }, read: reads });
    await t.click(/^Show the skill find-policies$/);
    expect(t.card("find-policies")!.textContent).toContain("Open the policies page first.");
    await t.click(/^Approve find-policies$/);
    expect(t.calls).toContain(`approve ${SKILL_FILE} "v-${SKILL_FILE}"`);
  });

  it("a text that could not be read is read again by Try again, the card staying open", async () => {
    let tries = 0;
    const t = await open(agent(true), { learning: async () => learned(), read: async (file: string) => { tries++; if (tries === 1) throw new Error("down"); return reads(file); } });
    await t.click(/^Show the skill find-policies$/);
    expect(t.card("find-policies")!.textContent).not.toContain("Open the policies page first.");
    await t.click(/^Try again$/);
    expect(tries).toBe(2);
    expect(t.card("find-policies")!.textContent).toContain("Open the policies page first.");
  });

  it("without the owner's password sign-in, one that waits says why, and there is no Approve", async () => {
    const t = await open(agent(true), { learning: async () => learned({ skill: "pending" }), caps: { learning: { pending: true, approve: false, approve_needs: "password" } } });
    expect(t.card("find-policies")!.textContent).toContain("Approving needs your password sign-in.");
    expect(t.button(/^Approve find-policies$/)).toBeUndefined();
  });

  it("an approve answered 412 says it changed, in the notes' words, and the tab is not read again", async () => {
    const t = await open(agent(true), { learning: async () => learned({ skill: "pending" }), read: reads, caps: { learning: { pending: true, approve: true } }, approve: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
    await t.click(/^Approve find-policies$/);
    expect(t.calls).toContain(`approve ${SKILL_FILE} "skill-v1"`);
    expect(t.card("find-policies")!.textContent).toContain("It changed since you opened it. Reload the tab to see the newest version.");
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(1);
  });

  it("an approve that landed, then a re-read that failed, leaves the skill's Approve usable again, never stuck on Approving", async () => {
    let n = 0;
    let fail!: (e: unknown) => void;
    const t = await open(agent(true), { learning: () => (n++ === 0 ? Promise.resolve(learned({ skill: "pending" })) : new Promise<AgentLearning>((_, reject) => { fail = reject; })), read: reads, caps: { learning: { pending: true, approve: true } } });
    await t.click(/^Approve find-policies$/);
    expect(t.calls).toContain(`approve ${SKILL_FILE} "skill-v1"`);
    // While the tab reads the list again, it stays Approving.
    const during = t.button(/^Approve find-policies$/) as HTMLButtonElement;
    expect([during.textContent, during.disabled]).toEqual(["Approving", true]);
    await act(async () => { fail(new ClientError(503, "unavailable", "The server is restarting.")); });
    await settle();
    expect(t.text()).toContain("Couldn't refresh the notes");
    const after = t.button(/^Approve find-policies$/) as HTMLButtonElement;
    expect([after.textContent, after.disabled]).toEqual(["Approve", false]);
  });

  describe("retiring one", () => {
    it("an active skill has Retire: it asks first, in the notes' words, and retires on the listing's version of its SKILL.md, with no read", async () => {
      let n = 0;
      const t = await open(agent(true), { learning: async () => (++n === 1 ? learned() : learned({ skill: "retired" })), read: reads });
      await t.click(/^Retire find-policies$/);
      const dialog = t.host.querySelector('[role="alertdialog"]')!;
      expect(dialog.getAttribute("aria-label")).toBe("Retire find-policies?");
      expect(dialog.textContent).toContain("Retire it? Later runs stop getting it. It stays under Earlier skills.");
      expect(document.activeElement?.textContent).toBe("Yes, retire");
      // Esc, as Keep, leaves it.
      await t.key(dialog, "Escape");
      expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
      expect(t.calls.some((c) => c.startsWith("retire"))).toBe(false);
      await t.click(/^Retire find-policies$/);
      await t.click(/^Keep$/);
      expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
      await t.click(/^Retire find-policies$/);
      await t.click(/^Yes, retire$/);
      expect(t.calls).toContain(`retire ${SKILL_FILE} "skill-v1"`);
      expect(t.calls.some((c) => c.startsWith("read"))).toBe(false);
      expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
      // Read again, it is retired: out of the list in use, under Earlier skills, no longer counted.
      expect(t.card("find-policies")).toBeNull();
      const skills = t.host.querySelector('section[aria-label="Skills it learned"]') as HTMLElement;
      expect(skills.textContent).toContain("No skill is in use: the next run gets none.");
      const earlier = skills.querySelector('section[aria-label="Earlier skills"]') as HTMLElement;
      expect(earlier?.textContent).toContain("Earlier skills1 no longer given");
      await t.click(/^Earlier skills/);
      expect(earlier.textContent).toContain("find-policies");
      expect(earlier.textContent).toContain("Retired");
      expect(t.button(/^Retire find-policies$/)).toBeUndefined();
      expect(t.button(/^Approve find-policies$/)).toBeUndefined();
    });

    it("retiring a skill that is open retires the version it shows, as Approve does: the one read when it opened", async () => {
      const t = await open(agent(true), { learning: async () => learned(), read: reads });
      await t.click(/^Show the skill find-policies$/);
      expect(t.card("find-policies")!.textContent).toContain("Open the policies page first.");
      await t.click(/^Retire find-policies$/);
      await t.click(/^Yes, retire$/);
      expect(t.calls).toContain(`retire ${SKILL_FILE} "v-${SKILL_FILE}"`);
    });

    it("a retire that landed stays Retiring while the tab reads the list again; a re-read that fails leaves Retire usable", async () => {
      let n = 0;
      let fail!: (e: unknown) => void;
      const t = await open(agent(true), { learning: () => (n++ === 0 ? Promise.resolve(learned()) : new Promise<AgentLearning>((_, reject) => { fail = reject; })), read: reads });
      await t.click(/^Retire find-policies$/);
      await t.click(/^Yes, retire$/);
      expect(t.calls).toContain(`retire ${SKILL_FILE} "skill-v1"`);
      const during = t.button(/^Retiring$/) as HTMLButtonElement;
      expect(during, "the confirm says Retiring while the list is read again").toBeTruthy();
      expect(during.disabled).toBe(true);
      expect(t.button(/^Retire find-policies$/)).toBeUndefined();
      await act(async () => { fail(new ClientError(503, "unavailable", "The server is restarting.")); });
      await settle();
      expect(t.text()).toContain("Couldn't refresh the notes");
      expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
      const after = t.button(/^Retire find-policies$/) as HTMLButtonElement;
      expect([after.textContent, after.disabled]).toEqual(["Retire", false]);
    });

    it("a draft workflow is retired by its README, never its workflow.json, and moves under Earlier workflows", async () => {
      let n = 0;
      const t = await open(agent(true), { learning: async () => (++n === 1 ? learned() : learned({ workflow: "retired" })), read: reads });
      await t.click(/^Retire check-refunds$/);
      expect(t.host.querySelector('[role="alertdialog"]')!.textContent).toContain("Retire it? Later runs stop getting it. It stays under Earlier workflows.");
      await t.click(/^Yes, retire$/);
      expect(t.calls).toContain(`retire ${README_FILE} "readme-v1"`);
      expect(t.calls.some((c) => c.startsWith(`retire ${DRAFT_FILE}`))).toBe(false);
      expect(t.card("check-refunds")).toBeNull();
      const flows = t.host.querySelector('section[aria-label="Workflows it learned"]') as HTMLElement;
      expect(flows.textContent).toContain("No workflow is in use: the next run gets none.");
      expect(flows.querySelector('section[aria-label="Earlier workflows"]')?.textContent).toContain("Earlier workflows1 no longer given");
      // The skill beside it is untouched.
      expect(t.card("find-policies")).not.toBeNull();
    });

    it("one that changed since the listing (412) says so in the notes' words, and is not retired", async () => {
      const t = await open(agent(true), { learning: async () => learned(), read: reads, retire: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
      await t.click(/^Retire find-policies$/);
      await t.click(/^Yes, retire$/);
      expect(t.card("find-policies")!.textContent).toContain("It changed since you opened it. Reload the tab to see the newest version.");
      expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(1);
    });

    it("any other refusal says the skill was not retired, in the problem card's words", async () => {
      const t = await open(agent(true), { learning: async () => learned(), read: reads, retire: async () => { throw new ClientError(400, "bad_request", "A workflow is retired by its README.md."); } });
      await t.click(/^Retire find-policies$/);
      await t.click(/^Yes, retire$/);
      expect(t.card("find-policies")!.textContent).toContain("The skill was not retired.");
    });

    it("one the server lists retired has no Retire and no Approve, is not counted, and says who retired it and when", async () => {
      const v = learned({ skill: "retired", workflow: "retired" });
      v.skills = [...v.skills!, { name: "read-receipts", file: "skills/read-receipts/SKILL.md", description: "Read a receipt", status: "pending", run: "run-b", bytes: 40, etag: '"rr-v1"' }];
      v.skills = v.skills!.map((x) => (x.file === SKILL_FILE ? { ...x, retired: { at: "2026-11-04T10:00:00Z", by: "person" as const } } : x));
      const t = await open(agent(true), { learning: async () => v, read: reads, caps: { learning: { pending: true, approve: true } } });
      const skills = t.host.querySelector('section[aria-label="Skills it learned"]') as HTMLElement;
      expect(skills.textContent).toContain("1 skill: how to do a job it does again");
      await t.click(/^Earlier skills/);
      await t.click(/^Earlier workflows/);
      expect(t.button(/^Retire find-policies$/)).toBeUndefined();
      expect(t.button(/^Approve find-policies$/)).toBeUndefined();
      expect(t.button(/^Retire check-refunds$/)).toBeUndefined();
      expect(t.button(/^Approve check-refunds$/)).toBeUndefined();
      expect(skills.querySelector('section[aria-label="Earlier skills"]')!.textContent).toContain("Retired by you ·");
      // One that waits has Approve and Retire, as a note that waits does.
      expect(t.button(/^Approve read-receipts$/)).toBeTruthy();
      expect(t.button(/^Retire read-receipts$/)).toBeTruthy();
    });

    it("an archived agent's skills have no Retire", async () => {
      const t = await open({ ...agent(true), archived_at: "2026-11-03T17:00:00Z" }, { learning: async () => learned(), read: reads });
      expect(t.card("find-policies")).not.toBeNull();
      expect(t.button(/^Retire find-policies$/)).toBeUndefined();
      expect(t.button(/^Retire check-refunds$/)).toBeUndefined();
    });
  });
});

// "What the next run reads": the notes in use (the index) and the skills it is given, the active ones. A run after an
// Approve is given the approved skill, so an agent whose learning is a skill alone never reads "nothing"; a skill that
// waits for its owner's OK is given to no run, so it is left out.
describe("the Learning tab's \"What the next run reads\"", () => {
  const skill = (name: string, status: "active" | "pending") => ({ name, file: `skills/${name}/SKILL.md`, description: `When ${name} applies`, status, run: "run-b", bytes: 92, etag: `"${name}-v1"` });
  const skillsOnly = () => view({ index: "", notes: { items: [], total: 0, next_cursor: null }, skills: [skill("find-policies", "active"), skill("issue-refunds", "pending")] } as Partial<AgentLearning>);
  const panel = (t: Awaited<ReturnType<typeof open>>) => t.host.querySelector('section[aria-label="What the next run reads"]') as HTMLElement;

  it("counts and names the active skill it is given when no note is in use, and leaves out a pending one", async () => {
    const t = await open(agent(true), { learning: async () => skillsOnly() });
    const p = panel(t);
    expect(p).toBeTruthy();
    expect(p.querySelector("button")!.textContent).toContain("1 skill");
    expect(p.querySelector("button")!.textContent).not.toContain("nothing");
    await act(async () => { p.querySelector("button")!.click(); });
    expect(p.textContent).toContain("Active skills: find-policies");
    expect(p.textContent).toContain("Read-only: the notes in use, one line each, and the agent's active skills.");
    expect(p.textContent).not.toContain("issue-refunds");
    expect(p.textContent).not.toContain("Nothing yet");
  });

  it("wraps a skill's long name rather than spilling it out of the panel", async () => {
    const long = `find-${"a".repeat(59)}`;
    const t = await open(agent(true), { learning: async () => view({ index: "", notes: { items: [], total: 0, next_cursor: null }, skills: [skill(long, "active")] } as Partial<AgentLearning>) });
    const p = panel(t);
    await act(async () => { p.querySelector("button")!.click(); });
    const line = [...p.querySelectorAll("p")].find((x) => x.textContent?.includes(long))!;
    expect(long.length).toBe(64);
    expect(line.className.split(" ")).toContain("break-words");
  });

  it("says the next run gets nothing when learning is off, for the agent or on this server", async () => {
    for (const [a, server] of [[agent(false), undefined], [agent(true), "off"]] as const) {
      const t = await open(a, { learning: async () => skillsOnly() }, server ? { server } : {});
      const p = panel(t);
      expect(p.querySelector("button")!.textContent).toContain("nothing");
      await act(async () => { p.querySelector("button")!.click(); });
      expect(p.textContent).toContain("Learning is off: the next run gets no notes or skills.");
      expect(p.textContent).not.toContain("Active skills");
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("counts notes and skills together", async () => {
    const t = await open(agent(true), { learning: async () => view({ skills: [skill("find-policies", "active")] } as Partial<AgentLearning>) });
    expect(panel(t).querySelector("button")!.textContent).toMatch(/\d+ notes? · 1 skill/);
  });
});

// A placeholder in angle brackets is text wherever learning shows it: a note's card and a skill (rendered from Markdown,
// where "<name>" was taken for an HTML tag and dropped), a workflow draft (shown as its text).
describe("text in angle brackets in what it learned", () => {
  const BODY = 'A refund summary is three lines:\n"Customer: <name>"\n"Amount: $<amount>"\n';
  const SKILL_FILE = "skills/refund-summary/SKILL.md";
  const DRAFT_FILE = "workflows/refund-summary/workflow.json";
  const withAngles = () => view({
    notes: { items: [note("refund-summary-format.md", "Refund summary format", { text: `---\nname: Refund summary format\ndescription: Use for a refund summary\ntype: feedback\n---\n${BODY}` })], total: 1, next_cursor: null },
    skills: [{ name: "refund-summary", file: SKILL_FILE, description: "Write a refund summary", status: "active", run: "run-b", bytes: 120, etag: '"s1"' }],
    workflows: [{ name: "refund-summary", file: DRAFT_FILE, readme: "workflows/refund-summary/README.md", description: "Summarise a refund", status: "active", run: "run-a", bytes: 80, etag: '"r1"' }],
  } as Partial<AgentLearning>);
  const reads = async (file: string) => ({ note: file === SKILL_FILE ? `---\nname: refund-summary\ndescription: Write a refund summary\n---\n${BODY}` : '{"template": "Customer: <name>, Amount: $<amount>"}\n', etag: `"v-${file}"` });

  it("a note's card shows <name> and $<amount> as written", async () => {
    const t = await open(agent(true), { learning: async () => withAngles(), read: reads });
    const card = t.card("Refund summary format")!;
    expect(card.textContent).toContain('"Customer: <name>"');
    expect(card.textContent).toContain('"Amount: $<amount>"');
  });

  it("an opened skill and an opened workflow draft show them as written too", async () => {
    const t = await open(agent(true), { learning: async () => withAngles(), read: reads });
    await t.click(/^Show the skill refund-summary$/);
    const skill = t.host.querySelector('section[aria-label="Skills it learned"]') as HTMLElement;
    expect(skill.textContent).toContain('"Customer: <name>"');
    expect(skill.textContent).toContain('"Amount: $<amount>"');
    await t.click(/^Show the workflow refund-summary$/);
    const flow = t.host.querySelector('section[aria-label="Workflows it learned"]') as HTMLElement;
    expect(flow.textContent).toContain("Customer: <name>, Amount: $<amount>");
  });
});

// A retired note or skill opens as one in use does, read-only: what it says, when it applies, the run that learned it, and
// who retired it when. Nothing to edit or retire on it: no later run reads it.
describe("the Learning tab's retired notes and skills, opened", () => {
  const retiredView = () => view({
    notes: { items: [note(FIRST, "Try /policies/refund-policy first"), note(MINE, "Keep it to three lines", { status: "retired", retired: { at: "2026-11-04T09:10:00Z", by: "person" } })], total: 2, next_cursor: null },
    log: { items: [
      { by: { user: true }, commit: "c4", at: "2026-11-04T09:10:00Z", reason: "retired by a person", files: [MINE, "MEMORY.md"] },
      { by: { run: "run-a" }, commit: "c1", at: "2026-11-03T16:52:10Z", reason: "Short answers read better.", files: [MINE, FIRST, "MEMORY.md"] },
    ], total: 2, next_cursor: null },
  });

  it("a retired note opens to its text, when it applies, the run that learned it and when you retired it, with no Edit or Retire", async () => {
    const t = await open(agent(true), { learning: async () => retiredView() });
    await t.click(/^Earlier notes/);
    const earlier = t.host.querySelector('section[aria-label="Earlier notes"]') as HTMLElement;
    expect(earlier.textContent).not.toContain("The body of Keep it to three lines.");
    await t.click(/^Show the note Keep it to three lines$/);
    expect(earlier.textContent).toContain("The body of Keep it to three lines.");
    expect(earlier.textContent).toContain("When keep it to three lines applies");
    expect(earlier.textContent).toContain("Learned in");
    expect(earlier.querySelector('a[href="#/runs/run-a"]')?.textContent).toBe("taylorstitch.com");
    expect(earlier.textContent).toMatch(/Retired by you · \S/);
    expect(t.button(/^Edit Keep it to three lines$/)).toBeUndefined();
    expect(t.button(/^Retire Keep it to three lines$/)).toBeUndefined();
    await t.click(/^Hide the note Keep it to three lines$/);
    expect(earlier.textContent).not.toContain("The body of Keep it to three lines.");
  });

  it("a retired skill opens to its text, read from its file, and the run that learned it, with no Approve or Retire", async () => {
    const SKILL_FILE = "skills/find-policies/SKILL.md";
    const SKILL_TEXT = "---\nname: find-policies\ndescription: Find a store's policies\n---\n# Find policies\n\n1. Open the policies page first.\n";
    const learned = view({ skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: "retired", run: "run-b", bytes: 92, etag: '"skill-v1"' }], workflows: [] } as Partial<AgentLearning>);
    const t = await open(agent(true), { learning: async () => learned, read: async () => ({ note: SKILL_TEXT, etag: '"skill-v1"' }) });
    await t.click(/^Earlier skills/);
    const earlier = t.host.querySelector('section[aria-label="Earlier skills"]') as HTMLElement;
    await t.click(/^Show the skill find-policies$/);
    expect(t.calls).toContain(`read ${SKILL_FILE}`);
    expect(earlier.textContent).toContain("Open the policies page first.");
    expect(earlier.querySelector('a[href="#/runs/run-b"]')?.textContent).toBe("brooklinen.com");
    expect(earlier.textContent).toContain("Retired");
    expect(t.button(/^Retire find-policies$/)).toBeUndefined();
    expect(t.button(/^Approve find-policies$/)).toBeUndefined();
  });

  it("an open retired skill reads its text again when the list moves to another version (a restore made on an old one)", async () => {
    const SKILL_FILE = "skills/find-policies/SKILL.md";
    const text = (step: string) => `---\nname: find-policies\ndescription: Find a store's policies\n---\n# Find policies\n\n1. ${step}\n`;
    const listed = (etag: string) => view({ skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: "retired", run: "run-b", bytes: 92, etag }], workflows: [] } as Partial<AgentLearning>);
    let version = '"skill-v1"';
    const t = await open(agent(true), {
      learning: async () => listed(version),
      read: async () => ({ note: text(version === '"skill-v1"' ? "The old step." : "The newer step."), etag: version }),
      // Someone restored it, a run changed it, and it was retired again: the restore on v1 is refused, and the list moves.
      restore: async () => { version = '"skill-v3"'; throw new ClientError(412, "precondition_failed", "changed"); },
    });
    await t.click(/^Earlier skills/);
    const earlier = t.host.querySelector('section[aria-label="Earlier skills"]') as HTMLElement;
    await t.click(/^Show the skill find-policies$/);
    expect(earlier.textContent).toContain("The old step.");
    await t.click(/^Restore find-policies$/);
    await t.click(/^Yes, restore$/);
    expect(t.text()).toContain("It changed since you opened it.");
    const shown = t.host.querySelector('section[aria-label="Earlier skills"]') as HTMLElement;
    expect(shown.textContent).toContain("The newer step.");
    expect(shown.textContent).not.toContain("The old step.");
  });

  it("a read of the old version that answers late never replaces the newer text", async () => {
    const SKILL_FILE = "skills/find-policies/SKILL.md";
    const text = (step: string) => `---\nname: find-policies\ndescription: Find a store's policies\n---\n# Find policies\n\n1. ${step}\n`;
    const listed = (etag: string) => view({ skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: "retired", run: "run-b", bytes: 92, etag }], workflows: [] } as Partial<AgentLearning>);
    let version = '"skill-v1"';
    let release: () => void = () => {};
    let reads = 0;
    const t = await open(agent(true), {
      learning: async () => listed(version),
      // The first read (of v1) is held until released; the one after the list moves answers at once.
      read: async () => {
        if (reads++ === 0) return new Promise((done) => { release = () => done({ note: text("The old step."), etag: '"skill-v1"' }); });
        return { note: text("The newer step."), etag: version };
      },
      restore: async () => { version = '"skill-v3"'; throw new ClientError(412, "precondition_failed", "changed"); },
    });
    await t.click(/^Earlier skills/);
    await t.click(/^Show the skill find-policies$/);
    await t.click(/^Restore find-policies$/);
    await t.click(/^Yes, restore$/);
    const earlier = () => t.host.querySelector('section[aria-label="Earlier skills"]')?.textContent ?? "";
    expect(earlier()).toContain("The newer step.");
    await act(async () => { release(); });
    await settle();
    expect(earlier()).toContain("The newer step.");
    expect(earlier()).not.toContain("The old step.");
  });
});

// What a card says of its newest change, as the server names it (last_change): approved, restored, retired, edited or
// created by you, each with when; learned by a run, none (Learned in says it). A retired one says who retired it and
// when (retired). With neither served, a card names no change.
describe("the Learning tab's words for the newest change", () => {
  const AT = "2026-11-05T19:30:00Z";
  it("says Approved by you or Restored by you when the server names it, never Edited", async () => {
    const v = view();
    v.notes.items = v.notes.items.map((x) => (x.file === MINE ? { ...x, last_change: { kind: "approved" as const, by: "person" as const, at: AT } } : x.file === FIRST ? { ...x, last_change: { kind: "restored" as const, by: "person" as const, at: AT } } : x));
    const t = await open(agent(true), { learning: async () => v });
    expect(t.card("Keep it to three lines")!.textContent).toMatch(/Approved by you · \S/);
    expect(t.card("Keep it to three lines")!.textContent).not.toContain("Edited by you");
    expect(t.card("Try /policies/refund-policy first")!.textContent).toMatch(/Restored by you · \S/);
    // The run that learned it is still named.
    expect(t.card("Try /policies/refund-policy first")!.querySelector('a[href="#/runs/run-b"]')).not.toBeNull();
  });
  it("names who retired one from the served retired field: you, or a run", async () => {
    const v = view();
    v.notes.items = [note(FIRST, "Try /policies/refund-policy first"), note(MINE, "Keep it to three lines", { status: "retired", retired: { at: AT, by: "person" } }), note(OLD, "Shopify refund policy path", { status: "retired", retired: { at: AT, by: "run" } })];
    const t = await open(agent(true), { learning: async () => v });
    await t.click(/^Earlier notes/);
    const earlier = t.host.querySelector('section[aria-label="Earlier notes"]')!.textContent ?? "";
    expect(earlier).toMatch(/Retired by you · \S/);
    expect(earlier).toMatch(/Retired by a run · \S/);
  });
});

// A retired note, skill or draft can be restored: after a confirm, on the version its card shows (If-Match), then the tab
// reads it again. A refusal says why in plain words, and it stays retired.
describe("restoring a retired note, skill or draft", () => {
  const retiredView = () => {
    const v = view();
    v.notes.items = [note(FIRST, "Try /policies/refund-policy first", { etag: '"v-first"' }), note(MINE, "Keep it to three lines", { status: "retired", etag: '"v-mine"' })];
    return v;
  };
  const restoreOf = async (t: Awaited<ReturnType<typeof open>>) => {
    await t.click(/^Earlier notes/);
    await t.click(/^Restore Keep it to three lines$/);
  };

  it("asks first, then restores on the version the card shows, and reads the tab again", async () => {
    let reads = 0;
    const t = await open(agent(true), { learning: async () => { reads++; return retiredView(); } });
    await restoreOf(t);
    const ask = t.host.querySelector('[role="alertdialog"]');
    expect(ask?.textContent).toContain("It becomes active again for the next run.");
    expect(t.calls.some((c) => c.startsWith("restore "))).toBe(false);
    const before = reads;
    await t.click(/^Yes, restore$/);
    expect(t.calls).toContain(`restore ${MINE} "v-mine"`);
    expect(reads).toBeGreaterThan(before);
  });

  it("a version changed since says so and reads the tab again", async () => {
    let reads = 0;
    const t = await open(agent(true), { learning: async () => { reads++; return retiredView(); }, restore: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
    await restoreOf(t);
    const before = reads;
    await t.click(/^Yes, restore$/);
    expect(t.text()).toContain("It changed since you opened it.");
    expect(reads).toBeGreaterThan(before);
  });

  it("a refusal by the checks shows the server's words, and it stays retired", async () => {
    const refusal = Object.assign(new ClientError(400, "bad_request", "The note does not pass the checks: secret_shape."), { problems: [{ rule: "secret_shape", path: MINE, detail: "It holds something shaped like a key (sk-…)." }] });
    const t = await open(agent(true), { learning: async () => retiredView(), restore: async () => { throw refusal; } });
    await restoreOf(t);
    await t.click(/^Yes, restore$/);
    expect(t.text()).toContain("It holds something shaped like a key (sk-…).");
    expect(t.host.querySelector('section[aria-label="Earlier notes"]')!.textContent).toContain("Keep it to three lines");
  });

  it("a token, not the owner's sign-in, is told restoring takes the password sign-in", async () => {
    const t = await open(agent(true), { learning: async () => retiredView(), restore: async () => { throw new ClientError(403, "forbidden", "Restoring a retired note takes the owner's password sign-in in the console, never a token."); } });
    await restoreOf(t);
    await t.click(/^Yes, restore$/);
    expect(t.text()).toContain("Restoring takes your password sign-in in the console.");
  });

  it("one no longer retired (restored elsewhere) reads the tab again", async () => {
    let reads = 0;
    const t = await open(agent(true), { learning: async () => { reads++; return retiredView(); }, restore: async () => { throw new ClientError(400, "bad_request", "The note is not retired: it is active."); } });
    await restoreOf(t);
    const before = reads;
    await t.click(/^Yes, restore$/);
    expect(reads).toBeGreaterThan(before);
  });

  it("a skill is restored by its SKILL.md and a draft by its README, on the listed versions", async () => {
    const SKILL_FILE = "skills/find-policies/SKILL.md";
    const README_FILE = "workflows/check-refunds/README.md";
    const v = view({
      skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: "retired", run: "run-b", bytes: 92, etag: '"skill-v1"' }],
      workflows: [{ name: "check-refunds", file: "workflows/check-refunds/workflow.json", readme: README_FILE, description: "Checks a store's refund window", status: "retired", run: "run-a", bytes: 640, etag: '"readme-v1"' }],
    } as Partial<AgentLearning>);
    const t = await open(agent(true), { learning: async () => v });
    await t.click(/^Earlier skills/);
    await t.click(/^Restore find-policies$/);
    await t.click(/^Yes, restore$/);
    expect(t.calls).toContain(`restore ${SKILL_FILE} "skill-v1"`);
    await t.click(/^Earlier workflows/);
    await t.click(/^Restore check-refunds$/);
    await t.click(/^Yes, restore$/);
    expect(t.calls).toContain(`restore ${README_FILE} "readme-v1"`);
  });

  it("an archived agent's retired notes have no Restore", async () => {
    const t = await open({ ...agent(true), archived_at: "2026-11-05T00:00:00Z" }, { learning: async () => retiredView() });
    await t.click(/^Earlier notes/);
    expect(t.button(/^Restore Keep it to three lines$/)).toBeUndefined();
  });
});

// Who changed it comes only from what the server names (last_change, retired): a person's commit in the learning log
// alone names no one, and nothing more of the log is read to find one.
describe("the Learning tab's lines name only what the server serves", () => {
  it("a person's change in the log alone gives a card no by-line", async () => {
    const t = await open(agent(true), { learning: async () => view() });
    const mine = t.card("Keep it to three lines")!;
    expect(mine.textContent).not.toMatch(/(Written|Edited|Created) by you/);
  });
  it("a retired skill the server names no retirement of says just Retired, and no more of the log is read for it", async () => {
    const SKILL_FILE = "skills/find-policies/SKILL.md";
    const v = view({ skills: [{ name: "find-policies", file: SKILL_FILE, description: "Find a store's policies", status: "retired", run: "run-b", bytes: 92, etag: '"skill-v1"' }], workflows: [] } as Partial<AgentLearning>);
    v.log = { ...v.log, items: [{ by: { user: true }, commit: "c9", at: "2026-11-04T10:00:00Z", reason: "retired by a person", files: [SKILL_FILE] }, ...v.log.items], next_cursor: "l1" };
    const t = await open(agent(true), { learning: async () => v });
    expect(t.calls).not.toContain("log after l1");
    await t.click(/^Earlier skills/);
    const earlier = t.host.querySelector('section[aria-label="Earlier skills"]')!.textContent ?? "";
    expect(earlier).toContain("Retired");
    expect(earlier).not.toContain("by you");
  });
});

// The panel of runs that kept nothing shows each run's sentence as the server says it, under a title that does not say
// "Not kept" again: whatever shape the sentence takes, "Not kept" appears once a row.
describe("the Learning tab's runs that kept nothing", () => {
  const SHAPES = [
    "Not kept: It's about one shop's returns portal, not a rule other shops share.",
    "Not kept, with the skill weekly-summary: it's about one shop's returns portal.",
    "Not kept, the skill find-policies: it named a value the server keeps secret.",
  ];
  it("lists each sentence as served, saying Not kept once in each row and not in the title", async () => {
    const runs = SHAPES.map((detail, i) => runOf(`run-d${i}`, `shop${i}.com`, { state: "dropped", reason: "grader", detail }));
    const t = await open(agent(true), { learning: async () => view(), runs });
    const panel = [...t.host.querySelectorAll("aside section")].find((s) => SHAPES.some((d) => s.textContent?.includes(d))) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("h2")!.textContent).not.toContain("Not kept");
    const rows = [...panel.querySelectorAll("li")].map((li) => li.querySelector("span")!.textContent ?? "");
    expect(rows).toEqual(SHAPES);
    for (const row of rows) expect(row.match(/Not kept/g)).toHaveLength(1);
  });
});

// How many runs a note was given to, and read in, as the server counts them (each note's `runs`): "Given to N runs", and
// "Read in N runs" once one read it. Never counted here from the runs the tab read.
describe("the Learning tab's per-note run counts", () => {
  it("says how many runs each note was given to and read in, from the server's counts", async () => {
    const v = view();
    v.notes.items = v.notes.items.map((x) => (x.file === FIRST ? { ...x, runs: { given: 3, read: 1 } } : x.file === MINE ? { ...x, runs: { given: 2, read: 0 } } : { ...x, runs: { given: 0, read: 0 } }) as never);
    const t = await open(agent(true), { learning: async () => v });
    const first = t.card("Try /policies/refund-policy first")!.textContent ?? "";
    expect(first).toContain("Given to 3 runs");
    expect(first).toContain("Read in 1 run");
    const mine = t.card("Keep it to three lines")!.textContent ?? "";
    expect(mine).toContain("Given to 2 runs");
    expect(mine).not.toContain("Read in");
  });
  it("counts nothing itself: runs that say they read a note leave its card as the server counts it", async () => {
    const v = view();
    v.notes.items = v.notes.items.map((x) => ({ ...x, runs: { given: 0, read: 0 } }) as never);
    const read = [{ file: FIRST, name: "Try" }];
    const runs = RUNS.map((r) => ({ ...r, learning: r.learning ? { ...r.learning, given: read, read } : r.learning }) as Run);
    const t = await open(agent(true), { learning: async () => v, runs });
    const first = t.card("Try /policies/refund-policy first")!.textContent ?? "";
    expect(first).toContain("Given to 0 runs");
    expect(first).not.toContain("Read in");
    expect(first).not.toContain("Used in");
  });
});
