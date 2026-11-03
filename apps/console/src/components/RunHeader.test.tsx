import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Cost, Run } from "@/lib/v2";

// The run page's cost says "est." and carries the estimate disclaimer for the same reason: whose number it is.
const runWith = (c: Cost): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Q",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: c, archived_at: null,
});
const DISCLAIMER = "A local estimate, not a bill";

it.each([
  ["calc", "#/agents/calc/runs"],
  ["agent one", "#/agents/agent%20one/runs"],
  ["new", "#/agents/new/runs"],
])("links a directly opened run back to its agent's runs: %s", async (agentId, target) => {
  const run = { ...runWith({ usd: null, basis: "estimate", charge_state: null, cap_usd: null }), agent_id: agentId };
  const host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = renderToStaticMarkup(createElement(RunHeader, { run, agentName: "Calc" }));
  const before = location.href;
  let moved: (() => void) | undefined;
  try {
    history.replaceState(null, "", "#/runs/r1");
    const link = host.querySelector<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a');
    expect(link, "the back arrow and agent name are a navigation link").not.toBeNull();
    expect(link!.getAttribute("href")).toBe(target);
    expect(link!.textContent).toContain("Calc");
    const navigated = new Promise<void>((resolve) => { moved = resolve; window.addEventListener("hashchange", moved, { once: true }); });
    link!.click();
    await navigated;
    expect(location.hash).toBe(target);
  } finally {
    host.remove();
    history.replaceState(null, "", before);
    if (moved) window.removeEventListener("hashchange", moved);
  }
});

it("hides stop and cancel when the server explicitly does not support them", () => {
  const run = { ...runWith({ usd: null, basis: "estimate", charge_state: null, cap_usd: null }), status: "working" as const, state: "working" as const };
  const html = renderToStaticMarkup(createElement(RunHeader, { run, agentName: "Calc", actions: { supported: { stop: false, cancel: false }, onStop: () => {}, onCancel: () => {} } }));
  const host = document.createElement("div");
  host.innerHTML = html;
  const labels = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
  expect(labels).not.toContain("Stop");
  expect(labels).not.toContain("Cancel run");
});

describe("RunHeader's cost", () => {
  it("a cost a provider reported has no estimate disclaimer, though its basis is estimate", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "estimate", source: "reported", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50");
    expect(html).not.toContain(DISCLAIMER);
  });
  it("an estimated cost has it, whatever its basis says", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "charge", source: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50 est.");
    expect(html).toContain(DISCLAIMER);
  });
  it("an unknown cost reads Unknown, with no estimate disclaimer, whatever its source or basis says", () => {
    for (const c of [{ source: "estimate" as const, basis: "estimate" }, { basis: "estimate" }]) {
      const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: null, charge_state: null, cap_usd: null, ...c }), agentName: "Calc" }));
      expect(html).toContain("Unknown");
      expect(html).not.toContain(DISCLAIMER);
    }
  });
});

describe("RunHeader's cost when requests were cut", () => {
  const unknown = { usd: null, basis: "estimate", charge_state: null, cap_usd: null };
  it("with a bound, says ≤ the bound and that some requests were cut, in place of Unknown", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ ...unknown, at_most_usd: 0.0421 }), agentName: "Calc" }));
    expect(html).toContain("≤ $0.05");
    expect(html).toContain("some requests were cut");
    expect(html).not.toContain("Unknown");
  });
  it("without one, says Unknown as it always did, and nothing about cut requests", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith(unknown), agentName: "Calc" }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain("≤");
    expect(html).not.toContain("some requests were cut");
  });
});
