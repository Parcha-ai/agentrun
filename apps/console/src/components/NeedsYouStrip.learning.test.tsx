import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";

// Needs you lists each agent whose learned items wait for the owner's OK (its `learning.pending`), with how many, linked
// to its Learning tab where they are approved, and counts them in its heading.
const base: NeedsYouProps = { asking: [], failed: [], live: [], agentName: (id) => id, onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null };
const mount = (p: Partial<NeedsYouProps>) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(NeedsYouStrip, { ...base, ...p }));
  return host;
};

describe("NeedsYouStrip, learned items waiting for the owner's OK", () => {
  it("lists each agent with its count, linked to its Learning tab, and counts them in the heading", () => {
    const host = mount({ learning: [{ agent_id: "qa-learn", name: "QA learn", pending: 2 }, { agent_id: "calc", name: "Calc", pending: 1 }] });
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Needs you");
    expect(host.querySelector("h2")?.textContent).toBe("Needs you · 3");
    const qa = host.querySelector('a[href="#/agents/qa-learn/learning"]') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.closest("li")?.textContent).toContain("QA learn");
    expect(qa.closest("li")?.textContent).toContain("2 learned items wait for your OK");
    expect(host.querySelector('a[href="#/agents/calc/learning"]')?.closest("li")?.textContent).toContain("1 learned item waits for your OK");
  });

  it("shows nothing for it when no agent's items wait", () => {
    expect(mount({ learning: [] }).innerHTML).toBe("");
  });
});
