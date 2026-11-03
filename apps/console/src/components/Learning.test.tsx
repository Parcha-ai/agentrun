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

type Fake = { learning?: () => Promise<AgentLearning>; runs?: Run[]; read?: (file: string) => Promise<{ note: string; etag: string | null }>; write?: (file: string, text: string, on: unknown) => Promise<unknown>; retire?: (file: string, etag: string) => Promise<unknown>; update?: (body: unknown, etag: string | null) => Promise<{ agent: Agent; etag: string }> };
async function open(a: Agent, fake: Fake = {}, props: Partial<LearningProps> = {}) {
  const calls: string[] = [];
  const agents: Agent[] = [];
  const v2 = {
    agentLearning: async (id: string) => { calls.push(`learning ${id}`); return (fake.learning ?? (async () => view()))(); },
    listAgentRuns: async (id: string) => { calls.push(`runs ${id}`); return { runs: fake.runs ?? RUNS, next_cursor: null }; },
    readNote: async (_id: string, file: string) => { calls.push(`read ${file}`); return (fake.read ?? (async (f: string) => ({ note: view().notes.items.find((x) => x.file === f)!.text, etag: `"v-${f}"` })))(file); },
    writeNote: async (_id: string, file: string, text: string, on: unknown) => { calls.push(`write ${file} ${JSON.stringify(on)}`); return (fake.write ?? (async () => ({ text, etag: '"v2"' })))(file, text, on); },
    retireNote: async (_id: string, file: string, etag: string) => { calls.push(`retire ${file} ${etag}`); return (fake.retire ?? (async () => ({ text: "", etag: '"v3"' })))(file, etag); },
    getAgent: async () => { calls.push("agent"); return { agent: a, etag: '"rv1"' }; },
    updateDefinition: async (_id: string, body: unknown, etag: string | null) => { calls.push(`put ${JSON.stringify(body)} ${etag}`); return (fake.update ?? (async () => ({ agent: { ...a, revision: "rv2", revisions: 2, definition: { ...a.definition, ...(body as { definition: object }).definition } }, etag: '"rv2"' })))(body, etag); },
    learningNotes: async () => ({ items: [], total: 0, next_cursor: null }),
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
    expect(first.querySelector('[title="feedback"]')?.textContent).toBe("How to work");
    expect(first.textContent).toContain("The body of Try /policies/refund-policy first.");
    expect(first.textContent).toContain("Learned in");
    expect(first.querySelector('a[href="#/runs/run-b"]')?.textContent).toBe("brooklinen.com");
    expect(first.textContent).toContain("Used in 3 runs");
    const mine = t.card("Keep it to three lines")!;
    expect(mine.textContent).toContain("Written by you");
    expect(mine.textContent).toContain("Used in 1 run");
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
  });
  it("a note an address points at is highlighted, and an earlier one opens its list", async () => {
    const t = await open(agent(true), {}, { focus: [FIRST, OLD] });
    expect(t.card("Try /policies/refund-policy first")!.className).toContain("border-primary");
    expect(t.card("Keep it to three lines")!.className).not.toContain("border-primary");
    expect(t.text()).toContain("Replaced by");
  });
  it("what the next run reads is the server's index, read-only, behind a toggle", async () => {
    const t = await open(agent(true));
    expect(t.text()).toContain("What the next run reads2 lines");
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
});

describe("retiring a note", () => {
  it("asks first, in plain words; Keep or Esc leaves it, and Retire retires it on the version read", async () => {
    const t = await open(agent(true));
    await t.click(/^Retire Keep/);
    const dialog = t.host.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Retire it? It leaves every later run's instructions; the record stays.");
    expect(document.activeElement?.textContent).toBe("Yes, retire");
    await t.key(dialog, "Escape");
    expect(t.host.querySelector('[role="alertdialog"]')).toBeNull();
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.calls).toContain(`retire ${MINE} "v-${MINE}"`);
    expect(t.calls.filter((c) => c === "learning refunds")).toHaveLength(2);
  });
  it("one changed since says so, and is not retired", async () => {
    const t = await open(agent(true), { retire: async () => { throw new ClientError(412, "precondition_failed", "changed"); } });
    await t.click(/^Retire Keep/);
    await t.click(/^Yes, retire$/);
    expect(t.text()).toContain("It changed since you opened it.");
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
    expect(t.text()).toContain("Another revision was saved first. (precondition_failed)");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
  it("with learning on and nothing learned yet: says so, and how many runs looked back", async () => {
    const t = await open(agent(true), { learning: async () => view({ notes: { items: [], total: 0, next_cursor: null } }), runs: [RUNS[0], RUNS[2]] });
    expect(t.text()).toContain("Nothing learned yet");
    expect(t.text()).toContain("2 runs looked back: nothing worth keeping yet.");
    expect(t.text()).toContain("Or write a note yourself");
  });
  it("learning on without the write tool says it needs it, quietly", async () => {
    const t = await open(agent(true, { tools: ["read"] }));
    expect(t.text()).toContain("Needs the write tool, for now");
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
    expect(t.host.querySelector('[aria-busy="true"]')?.getAttribute("aria-label")).toBe("Loading what it learned");
    await act(async () => { release(view()); });
    await settle();
    expect(t.text()).toContain("What it has learned");
  });
  it("a failed read says so with the server's message, and reads again on Try again", async () => {
    let n = 0;
    const t = await open(agent(true), { learning: async () => { if (n++ === 0) throw new ClientError(500, "internal", "The agent's notes could not be read."); return view(); } });
    expect(t.text()).toContain("What this agent learned could not be read.");
    expect(t.text()).toContain("The agent's notes could not be read. (internal)");
    await t.click(/Try again/);
    expect(t.text()).toContain("What it has learned");
  });
});
