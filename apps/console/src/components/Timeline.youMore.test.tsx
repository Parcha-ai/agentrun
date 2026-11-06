import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A person's message on the timeline (a `user_message` row: its summary "You: <first line>", its text the whole message)
// folds as an answer does: the first line, "…" when there is more, and the whole message one click away. A message of
// one line reads as it is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const THREE = "Install the Python package httpx in your box and tell me its version.\nTeam rule for every report: start with STATUS.\nEnd with a line that starts with Next:.";
const you = (text: string): TimelineRow => ({ id: "u", seq: 0, kind: "user_message", summary: `You: ${text.split("\n")[0]}`, text, timestamp: "2026-11-06T15:13:00.000Z", tool_name: null });
function render(row: TimelineRow) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows: [row], live: false })));
  const li = host.querySelector("li")!;
  const titleOf = () => [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-[15px]"))!.textContent;
  return { li, titleOf };
}

describe("Timeline, your message", () => {
  it("of three lines reads its first line and \"…\", and opens whole", async () => {
    const t = render(you(THREE));
    expect(t.titleOf()).toBe("Install the Python package httpx in your box and tell me its version.…");
    await act(async () => { t.li.querySelector("button")!.click(); });
    const whole = t.li.querySelector("pre")!.textContent!;
    expect(whole.split("\n")).toEqual(THREE.split("\n"));
  });
  it("of one line reads as it is, with no \"…\"", () => {
    expect(render(you("Check invoice INV-2291.")).titleOf()).toBe("Check invoice INV-2291.");
  });
});
