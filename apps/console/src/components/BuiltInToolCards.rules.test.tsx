import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltInToolCards } from "./BuiltInToolCards";
import { toolOffers } from "@/lib/agentForm";
import type { Place } from "@/lib/place";

// QA: the browser runs only on pi and only on the server (runner_only), but its card stated one rule at a time: on
// Claude it said "Runs on Pi here, not on Claude", and on pi in a box place it said nothing, the save refused after.
// A card now states every rule that keeps its tool off here, together.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const offers = toolOffers([
  { name: "browser", available: true, summary: "Drive a hosted browser.", blurb: "Browse the web", harnesses: ["pi"], runner_only: true },
  { name: "bash", available: true, summary: "Run a bash command in the run's box.", blurb: "Run shell commands", harnesses: ["pi", "claude-agent"], sandbox_only: true },
  { name: "read", available: true, summary: "Read a file.", harnesses: ["pi", "claude-agent"] },
]);
const DOCKER: Place = { mode: "sandbox", box: "docker" } as Place;
const RUNNER: Place = { mode: "runner" } as Place;
const SERVER_ONLY = "Server-only: it runs on the server, and this agent's place is the docker box";

/** The browser card's tag for `harness` on an agent whose place is `place`: its words, and the reason in full (its title,
 *  which a card sets only when the tag hides some of it, else the tag's own words). */
function browserTag(harness: string, place: Place) {
  const host = document.body.appendChild(document.createElement("ul"));
  root = createRoot(host);
  act(() => root!.render(createElement(BuiltInToolCards, { shown: offers, offers, tools: [], harness, place, places: null, onChange: () => {} })));
  const tag = host.querySelector('input[value="browser"]')!.closest("li")!.querySelector("[data-tag]");
  const out = { text: tag?.textContent ?? null, why: tag?.getAttribute("title") ?? tag?.textContent ?? null };
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  return out;
}

describe("a built-in tool's card", () => {
  it("reads the served runner_only", () => {
    expect(offers.map((t) => [t.name, t.runner_only ?? false])).toEqual([["browser", true], ["bash", false], ["read", false]]);
  });

  it("states both of the browser's rules on Claude in a box: the harnesses that run it, and that it runs on the server", () => {
    expect(browserTag("claude-agent", DOCKER).why).toBe(`Runs on Pi here, not on Claude; ${SERVER_ONLY}`);
  });

  it("on pi in a box, says it runs on the server only, tagged Server-only (before, it said nothing and the save refused it)", () => {
    expect(browserTag("pi", DOCKER)).toEqual({ text: "Server-only", why: SERVER_ONLY });
  });

  it("on Claude on the runner, says only the harness rule; on pi on the runner, nothing", () => {
    expect(browserTag("claude-agent", RUNNER).why).toBe("Runs on Pi here, not on Claude");
    expect(browserTag("pi", RUNNER)).toEqual({ text: null, why: null });
  });
});
