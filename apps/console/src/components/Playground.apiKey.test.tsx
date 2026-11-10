import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";
import { curlFor } from "@/lib/runStart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

// The server prints its key as AGENTRUN_API_KEY, and that's what a person has in their environment: the Playground's
// snippets read that name, never AGENTRUN_TOKEN (the console's own dev server's).
describe("the Playground's snippets name AGENTRUN_API_KEY", () => {
  it("cURL sends $AGENTRUN_API_KEY", () => {
    const c = curlFor("http://127.0.0.1:7340", "meeting-notes", { input: { content: "Go." } }, "k1");
    expect(c).toContain('-H "Authorization: Bearer $AGENTRUN_API_KEY"');
    expect(c).not.toContain("AGENTRUN_TOKEN");
  });

  it("the JavaScript snippet and the footer say AGENTRUN_API_KEY", () => {
    const base = agentFixture("invoice-checker");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, { agents: [base], revisions: [], efforts: [], origin: "http://serve.test", agentId: base.agent_id })));
    const fetchTab = [...host.querySelectorAll("button")].find((b) => b.textContent === "fetch");
    if (fetchTab) act(() => fetchTab.click());
    expect(host.textContent).toContain("process.env.AGENTRUN_API_KEY");
    expect(host.textContent).toContain("set AGENTRUN_API_KEY in your environment");
    expect(host.textContent).not.toContain("AGENTRUN_TOKEN");
  });
});
