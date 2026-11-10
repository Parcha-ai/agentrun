import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import { ClientError } from "@/lib/client";
import { computerRefusal } from "@/lib/computerAsk";
import type { Run } from "@/lib/v2";

// Mission Control's Needs you strip: a run whose agent asks for the person at its computer (its browser, a desktop or a
// phone) shows the ask in place, with the way to its screen and Done or Cancel, answered through the one hand-back.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse("2026-11-04T10:05:00Z");
const run = (id: string, over: Partial<Run>): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: id, agent_id: "shop", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: `Run ${id}`,
  created_at: "2026-11-04T10:00:00Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, ...over,
});
const BROWSER_ASK = { kind: "browser" as const, instruction: "Sign in to the shop.", completion_condition: "The cart page shows.", asked_at: "2026-11-04T10:03:00Z", expires_at: "2026-11-04T10:33:00Z" };
const DESKTOP_ASK = { kind: "computer" as const, computer: "desktop" as const, instruction: "Approve the dialog.", completion_condition: "The dialog closes.", asked_at: "2026-11-04T10:04:00Z", expires_at: "2026-11-04T10:34:00Z" };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount(asking: Run[], p: Partial<NeedsYouProps> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const props: NeedsYouProps = { asking, failed: [], live: [], agentName: () => "Shopper", now: () => NOW, onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null, ...p };
  const render = (next: Run[]) => act(() => root!.render(createElement(NeedsYouStrip, { ...props, asking: next })));
  render(asking);
  return { host, render };
}
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); };
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name);

describe("NeedsYouStrip, a run whose agent asks for the person at its computer", () => {
  for (const ask of [BROWSER_ASK, DESKTOP_ASK]) {
    it(`a ${ask.kind} ask shows the agent's words as its request, the way to its screen, and Done answers it once`, async () => {
      const answers: unknown[][] = [];
      const { host } = mount([run("b1", { pending: ask })], { onHandBack: async (...args) => { answers.push(args); return null; } });
      const card = host.querySelector("li[data-run='b1'] section[aria-label='Waiting for you at the computer']")!;
      expect(card.textContent).toContain(`Waiting for you · ${ask.kind === "browser" ? "browser" : "desktop"}`);
      expect(card.querySelector("[data-agent-request]")!.textContent).toContain(`The agent asks you to: ${ask.instruction}`);
      expect(card.textContent).toContain("You never need to type your AgentRun password for this.");
      expect([...card.querySelectorAll("a")].find((a) => a.textContent === "Open its screen")!.getAttribute("href")).toBe("#/runs/b1");
      await click(button(host, "Done"));
      expect(answers).toEqual([["b1", "done"]]);
    });
  }

  it("Cancel answers it cancelled; a refusal stays said after the card goes", async () => {
    const said = "It was already answered: done.";
    const { host, render } = mount([run("b1", { pending: BROWSER_ASK })], { onHandBack: async () => said });
    await click(button(host, "Cancel"));
    expect(host.querySelector("li[data-run='b1'] [role='alert']")?.textContent).toBe(said);
    // The run moved on (answered elsewhere): the card goes, the words stay.
    render([]);
    expect(host.querySelector("li[data-run='b1']")).toBeNull();
    expect(host.textContent).toContain(`your answer wasn't taken. ${said}`);
  });

  it("without a way to answer, the ask links to its run alone", () => {
    const { host } = mount([run("b1", { pending: DESKTOP_ASK })]);
    expect(button(host, "Done")).toBeUndefined();
    expect([...host.querySelectorAll("li[data-run='b1'] a")].some((a) => a.textContent === "Open its screen" && a.getAttribute("href") === "#/runs/b1")).toBe(true);
  });
});

describe("a refused hand-back, in words", () => {
  const refused = (outcome?: string) => Object.assign(new ClientError(409, "handoff_answered", "the server's words", false), outcome ? { details: { outcome } } : {});
  it("names an earlier answer's outcome, or the ask's expiry", () => {
    expect(computerRefusal(refused("done"), "hand")).toBe("It was already answered: done.");
    expect(computerRefusal(refused("cancelled"), "hand")).toBe("It was already answered: cancelled.");
    expect(computerRefusal(refused("expired"), "hand")).toBe("The ask expired before your answer: the agent was told.");
    expect(computerRefusal(refused(), "hand")).toBe("the server's words");
  });
  it("a 404 is no ask now, a 403 a token's call", () => {
    expect(computerRefusal(new ClientError(404, "not_found", "x", false), "hand")).toBe("The agent isn't asking for you now.");
    expect(computerRefusal(new ClientError(403, "forbidden", "x", false), "take")).toBe("Sign in with your password to do this from here.");
  });
});
