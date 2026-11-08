import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import { handBackRefusal } from "@/lib/browserAsk";
import { ClientError } from "@/lib/client";
import type { Run } from "@/lib/v2";

// The agent's ask for the person in its browser (#1703, liveview/2): the run reads input_required/waiting with
// pending {kind: "browser", instruction, completion_condition, asked_at, expires_at}, which survives a restart, so the
// strip and the run page render it from the run alone. Done and Cancel answer it (POST /v2/runs/{id}/browser/hand-back,
// owner session only), where capabilities say features.browser_live.ask; a message steers the run and is no answer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ASK = { kind: "browser" as const, instruction: "Sign in to the example site with your own account", completion_condition: "the page shows you are signed in", asked_at: "2026-11-05T10:00:00.000Z", expires_at: "2026-11-05T10:15:00.000Z" };
const NOW = Date.parse("2026-11-05T10:02:00.000Z");
const f = runFixture("run.completed.idle.1");
const asking = { ...f.run, kind: "agentic", status: "input_required", state: "waiting", result: null, ended_at: null, pending: ASK } as unknown as Run;

function mount(el: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim())) as HTMLButtonElement | undefined;
  const click = async (b: HTMLButtonElement | undefined) => { expect(b).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  return { host, button, click };
}

describe("the strip, a run waiting on the person in its browser", () => {
  const base: NeedsYouProps = { asking: [asking], failed: [], live: [], agentName: () => "Browsing", now: () => NOW, onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null };

  it("says what to do, when it's done and when the ask expires, from the run alone, with a way to its browser", () => {
    const m = mount(createElement(NeedsYouStrip, base));
    const card = m.host.querySelector('[aria-label="Waiting for you in the browser"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("Sign in to the example site with your own account");
    expect(card.textContent).toContain("Done when: the page shows you are signed in");
    expect(card.textContent).toMatch(/Expires/);
    // The run's title links there too (the card's heading); one link says it goes to the browser.
    expect([...card.querySelectorAll(`a[href="#/runs/${asking.run_id}"]`)].some((a) => /browser/i.test(a.textContent ?? ""))).toBe(true);
    // No answer box: a browser ask isn't answered in words.
    expect(card.querySelector("textarea")).toBeNull();
  });

  it("offers Done and Cancel only where the server takes the hand-back (onHandBack given)", async () => {
    const calls: string[] = [];
    const m = mount(createElement(NeedsYouStrip, { ...base, onHandBack: async (id: string, outcome: "done" | "cancelled") => { calls.push(`${id} ${outcome}`); return null; } } as never));
    await m.click(m.button(/^Done$/));
    expect(calls).toEqual([`${asking.run_id} done`]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const n = mount(createElement(NeedsYouStrip, base));
    expect(n.button(/^Done$/)).toBeUndefined();
    expect(n.button(/^Cancel$/)).toBeUndefined();
  });

  it("says a refused hand-back in words", async () => {
    const m = mount(createElement(NeedsYouStrip, { ...base, onHandBack: async () => "Sign in with your password to answer from here." } as never));
    await m.click(m.button(/^Cancel$/));
    expect(m.host.textContent).toContain("Sign in with your password to answer from here.");
  });

  it("keeps a late answer's refusal once the run has moved on and its card is gone, with the run named", async () => {
    // The page reads again after a refused answer (another page answered first): the ask is gone from `asking`.
    const props = { ...base, onHandBack: async () => "It was already answered: done." } as never;
    const m = mount(createElement(NeedsYouStrip, props));
    await m.click(m.button(/^Cancel$/));
    await act(async () => { root!.render(createElement(NeedsYouStrip, { ...(props as object), asking: [] } as never)); });
    const alert = m.host.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("It was already answered: done.");
    expect(alert.querySelector(`a[href="#/runs/${asking.run_id}"]`)).not.toBeNull();
  });
});

// The ask is the agent's words, and an agent can write a phishing-shaped one: every place it shows says it's the agent's
// request, shows it as plain text (no Markdown, no link, no HTML), and says the console's own fixed line under it.
describe("the agent's ask is labelled as the agent's, plain text, with the password line", () => {
  const PHISH = { ...ASK, instruction: "[Sign in](https://evil.example) **now** <b>x</b>", completion_condition: "[done](https://evil.example/d) <i>y</i>" };
  const phishing = { ...asking, pending: PHISH } as unknown as Run;
  const base: NeedsYouProps = { asking: [phishing], failed: [], live: [], agentName: () => "Browsing", now: () => NOW, onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null };
  const check = (card: HTMLElement) => {
    expect(card.textContent).toContain("The agent asks you to: [Sign in](https://evil.example) **now** <b>x</b>");
    expect(card.textContent).toContain("Done when: [done](https://evil.example/d) <i>y</i>");
    expect(card.querySelector('[data-agent-request]')?.textContent).toContain("Done when:");
    expect(card.querySelector('a[href^="https://evil"]')).toBeNull();
    expect(card.querySelector("b, i, strong, em")).toBeNull();
    expect(card.textContent).toContain("You never need to type your AgentRun password for this.");
  };
  it("in the strip", () => {
    const m = mount(createElement(NeedsYouStrip, base));
    check(m.host.querySelector('[aria-label="Waiting for you in the browser"]') as HTMLElement);
  });
  it("on the run page", () => {
    const m = mount(createElement(RunDetail, { run: phishing, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {} } as never));
    check(m.host.querySelector('[aria-label="Waiting for you in the browser"]') as HTMLElement);
  });
  it("on the timeline, its Waiting for you row reads as the agent's request, as text", async () => {
    const { Timeline } = await import("./Timeline");
    const row = { id: "w", seq: 3, kind: "waiting", summary: "Waiting for you: [Sign in](https://evil.example) **now** <b>x</b>", text: null, timestamp: "2026-11-05T10:00:00Z", tool_name: null } as never;
    const m = mount(createElement(Timeline, { rows: [row], live: false }));
    expect(m.host.textContent).toContain("The agent asks you to: [Sign in](https://evil.example) **now** <b>x</b>");
    expect(m.host.querySelector('a[href^="https://evil"]')).toBeNull();
    expect(m.host.querySelector("b, strong")).toBeNull();
  });
});

describe("a hand-back the server refuses, in words", () => {
  const held = (outcome: string) => Object.assign(new ClientError(409, "handoff_answered", "answered", false), { details: { outcome } });
  it("409 handoff_answered says it was already answered, and how", () => {
    expect(handBackRefusal(held("done"))).toBe("It was already answered: done.");
    expect(handBackRefusal(held("cancelled"))).toBe("It was already answered: cancelled.");
    expect(handBackRefusal(held("expired"))).toBe("The ask expired before your answer: the agent was told.");
  });
  it("403 says to sign in with the password, never the raw refusal", () => {
    expect(handBackRefusal(new ClientError(403, "forbidden", "A run's live browser view takes the owner's password sign-in in the console, never a token.", false))).toBe("Sign in with your password to answer from here.");
  });
});

describe("the run page, a run waiting on the person in its browser", () => {
  const page = (extra: Record<string, unknown> = {}) => mount(createElement(RunDetail, { run: asking, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, ...extra } as never));

  it("keeps a late answer's refusal once the run has moved on and the ask's card is gone", async () => {
    const extra = { onHandBack: async () => "The ask expired before your answer: the agent was told." };
    const m = page(extra);
    await m.click(m.button(/^Done$/));
    const movedOn = { ...asking, status: "working", state: "working", pending: null } as unknown as Run;
    await act(async () => { root!.render(createElement(RunDetail, { run: movedOn, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, ...extra } as never)); });
    expect(m.host.querySelector('[aria-label="Waiting for you in the browser"]')).toBeNull();
    expect(m.host.querySelector('[role="alert"]')?.textContent).toContain("The ask expired before your answer: the agent was told.");
  });

  it("shows the ask above the page, from the run alone, and opens on the Browser tab", () => {
    const m = page({ readBrowser: async () => ({ state: "live", viewer: "/v2/runs/x/browser/live/v/AbCdEfGhIjKlMnOpQrStUv#t=T" }) });
    const card = m.host.querySelector('[aria-label="Waiting for you in the browser"]') as HTMLElement;
    expect(card.textContent).toContain("Sign in to the example site with your own account");
    expect(card.textContent).toContain("Done when: the page shows you are signed in");
    expect(m.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(/^Browser/);
  });

  it("Done and Cancel answer it wherever the page answers (onHandBack): no capability gates them (every server serves ask)", async () => {
    const calls: string[] = [];
    const m = page({ onHandBack: async (outcome: string) => { calls.push(outcome); return null; } });
    await m.click(m.button(/^Cancel$/));
    expect(calls).toEqual(["cancelled"]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const n = page();
    expect(n.button(/^Done$/)).toBeUndefined();
  });

  it("Done answers once however fast it is clicked: one \"done\", and nothing else answers the ask", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const m = page({ onHandBack: (outcome: string) => { calls.push(outcome); return new Promise<null>((r) => { release = () => r(null); }); } });
    const done = m.button(/^Done$/)!;
    await act(async () => { done.click(); done.click(); m.button(/^Cancel$/)!.click(); });
    expect(calls).toEqual(["done"]);
    await act(async () => { release(); });
  });

  it("the message box says a message steers the run and doesn't answer the ask", () => {
    const m = page();
    const box = m.host.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Steer the run...");
    expect(m.host.textContent).toMatch(/steers the run.*doesn't answer the ask/i);
    expect(m.host.textContent).not.toContain("Answer the question");
  });
});
