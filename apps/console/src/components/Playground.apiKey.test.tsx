import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The Playground's code pane is a request for the reader's own code, an API client, which sets AGENTRUN_API_KEY (the
// serve README's client variable). AGENTRUN_TOKEN is the server's own: neither snippet nor its footer names it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  // The picker's positioning watches its field's size; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function open() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const agent = agentFixture("invoice-checker");
  act(() => root!.render(createElement(Playground, { agents: [agent], revisions: [], efforts: [], origin: "http://serve.test", agentId: agent.agent_id })));
  const pane = host.querySelector('section[aria-label="Code and response"]')!;
  const code = () => pane.querySelector("pre")!.textContent ?? "";
  const lang = (label: string) => act(() => { [...pane.querySelectorAll("button")].find((b) => b.textContent === label)!.click(); });
  return { pane, code, lang };
}

describe("the Playground's code for your own client", () => {
  it("the cURL form sends $AGENTRUN_API_KEY", () => {
    const t = open();
    t.lang("cURL");
    expect(t.code()).toContain("Bearer $AGENTRUN_API_KEY");
    expect(t.code()).not.toContain("AGENTRUN_TOKEN");
  });
  it("the JavaScript form reads process.env.AGENTRUN_API_KEY", () => {
    const t = open();
    t.lang("JavaScript");
    expect(t.code()).toContain("process.env.AGENTRUN_API_KEY");
    expect(t.code()).not.toContain("AGENTRUN_TOKEN");
  });
  it("its footer says to set AGENTRUN_API_KEY", () => {
    const footer = open().pane.querySelector("footer")!.textContent ?? "";
    expect(footer).toContain("AGENTRUN_API_KEY");
    expect(footer).not.toContain("AGENTRUN_TOKEN");
  });
});
