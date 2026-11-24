import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";

// A person's run on a harness recipe billed to its vendor's plan runs on its owner's own sign-in, and the vendor's terms
// line its terminal sign-in says first rides on the run's read (sign_in_warning). The run's page says it, above
// everything else the run shows; a run without one shows nothing of it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const f = runFixture("run.input_required.waiting.1");
function mount(run: Run) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, onMessage: () => {} })));
  return host;
}
const WARNING = "Model Agent runs on your own sign-in: the vendor's terms may not allow a third-party tool to use it.";

describe("a run on its owner's own sign-in", () => {
  it("says the vendor's terms line on its page", () => {
    const host = mount({ ...f.run, sign_in_warning: WARNING } as Run);
    const section = host.querySelector('section[aria-label="On your own sign-in"]');
    expect(section?.textContent).toContain(WARNING);
  });
  it("a run without one shows nothing of it", () => {
    const host = mount(f.run);
    expect(host.querySelector('section[aria-label="On your own sign-in"]')).toBeNull();
  });
});
