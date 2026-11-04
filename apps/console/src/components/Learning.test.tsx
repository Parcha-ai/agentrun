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
  file, name, description: `When ${name.toLowerCase()} applies`, type: "feedback", status: "active", superseded_by: null,
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
  runOf("run-e", "everlane.com", { state: "dropped", reason: "empty", used: [{ file: FIRST, name: "Try" }, { file: MINE, name: "Keep" }] }),
  runOf("run-k", "kith.com", { state: "dropped", reason: "grader", detail: "Not kept: It's about one shop's returns portal.", used: [{ file: FIRST, name: "Try" }] }),
  runOf("run-c", "allbirds.com", { state: "dropped", reason: "empty", used: [{ file: FIRST, name: "Try" }] }),
  runOf("run-b", "brooklinen.com", { state: "merged", reason: null, used: [{ file: OLD, name: "Old" }] }),
  runOf("run-p", "patagonia.com", { state: "dropped", reason: "no_budget" }),
  runOf("run-a", "taylorstitch.com", { state: "merged", reason: null }),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

type Fake = { learning?: () => Promise<AgentLearning>; runs?: Run[]; read?: (file: string) => Promise<{ note: string; etag: string | null }>; write?: (file: string, text: string, on: unknown) => Promise<unknown>; retire?: (file: string, etag: string) => Promise<unknown>; approve?: (file: string, etag: string) => Promise<unknown>; caps?: unknown; notes?: (cursor: string) => Promise<{ items: LearningNote[]; total: number; next_cursor: string | null }>; log?: (cursor: string) => Promise<AgentLearning["log"]>; runsNext?: string | null; update?: (body: unknown, etag: string | null) => Promise<{ agent: Agent; etag: string }> };
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
  it("shows each note in use with its type, its body, the run that learned it and how many runs used it", async () => {
    const t = await open(agent(true));
    expect(t.text()).toContain("What it has learned");
    expect(t.text()).toContain("2 notes in use. Every later run reads them before it starts.");
    const first = t.card("Try /policies/refund-policy first")!;
    // The type in plain words, the API's value in its tooltip.
    expect(first.textContent).toContain("How to work");
    expect(first.querySelector('[title="feedback"]')).toBeNull();
    expect(first.textContent).toContain("The body of Try /policies/refund-policy first.");
    expect(first.textContent).toContain("Learned in");
    expect(first.querySelector('a[href="#/runs/run-b"]')?.textContent).toBe("brooklinen.com");
    expect(first.textContent).toContain("Used in 3 runs");
    const mine = t.card("Keep it to three lines")!;
    expect(mine.textContent).toContain("Written by you");
    expect(mine.textContent).toContain("Used in 1 run");
  });
  it("one note in use is said as one: it, not them", async () => {
    const one = view();
    one.notes.items = one.notes.items.filter((x) => x.file !== MINE);
    one.index = `- [Try /policies/refund-policy first](${FIRST}) — Open it first\n`;
    const t = await open(agent(true), { learning: async () => one });
    expect(t.text()).toContain("1 note in use. Every later run reads it before it starts.");
    expect(t.text()).toContain("What the next run reads1 note");
  });
  it("a server that does not say what runs read shows no use count", async () => {
    const t = await open(agent(true), { runs: RUNS.map((r) => ({ ...r, learning: r.learning && { state: r.learning.state, reason: r.learning.reason } })) });
    expect(t.text()).not.toContain("Used in");
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
    const list = t.host.querySelector('section[aria-label="Not kept"]')!;
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("It's about one shop's returns portal.");
    expect(rows[0]).not.toContain("Not kept:");
    expect(rows[0]).toContain("kith.com");
    expect(rows[1]).toContain("Skipped: no budget left in this run to look back.");
    expect(rows).toHaveLength(2);
    expect(list.textContent).toContain("2 more runs had nothing new to remember.");
  });
  it("an older server's list, with no sentence, says the reason in the console's words", async () => {
    const t = await open(agent(true), { runs: [runOf("run-k", "kith.com", { state: "dropped", reason: "grader" })] });
    expect(t.host.querySelector('section[aria-label="Not kept"]')!.textContent).toContain("It wouldn't help later runs enough.");
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
    // A note with no history yet has no empty footer.
    expect(box.querySelector("article footer")).toBeNull();
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
  it("says how many of the latest runs used a note when there are more runs than it read", async () => {
    const t = await open(agent(true), { runsNext: "r1" });
    expect(t.card("Try /policies/refund-policy first")!.textContent).toContain("Used in 3 of the latest 6 runs");
  });
});

describe("the Learning tab's skills and workflows", () => {
  const SKILL_FILE = "skills/find-policies/SKILL.md";
  const DRAFT_FILE = "workflows/check-refunds/workflow.json";
  const README_FILE = "workflows/check-refunds/README.md";
  const SKILL_TEXT = "---\nname: find-policies\ndescription: Find a store's policies\n---\n# Find policies\n\n1. Open the policies page first.\n";
  const learned = (status: { skill?: "active" | "pending"; workflow?: "active" | "pending" } = {}) => view({
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
    // No edit and no retire: a skill or a workflow is a run's to change.
    expect(t.button(/^Edit find-policies$/)).toBeUndefined();
    expect(t.button(/^Retire find-policies$/)).toBeUndefined();
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
});
