import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { ClientError } from "@/lib/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); vi.useRealTimers(); document.body.innerHTML = ""; });

const step = (label: string) => ({ node: "code", label, code: "(s) => s" });
const wf = (labels: string[]) => ({ v: 2, name: "t", root: { node: "chain", steps: labels.map(step) } });
const mount = async (props: Parameters<typeof WorkflowEditor>[0]) => {
  box = document.createElement("div");
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => { root!.render(createElement(WorkflowEditor, props)); });
};

describe("WorkflowEditor", () => {
  it("counts reordered steps as a change, not as the same revision", async () => {
    await mount({ text: JSON.stringify(wf(["b", "a", "c"]), null, 2), onText: () => {}, base: wf(["a", "b", "c"]), baseLabel: "rev 1" });
    expect(box.textContent).not.toContain("Same as rev 1");
    expect(box.textContent).toMatch(/moved|connections? changed/);
  });
  it("names a failed server check, shows the local checks, and asks again on Retry", async () => {
    vi.useFakeTimers();
    const validate = vi.fn(async () => { throw new ClientError(500, "internal", "boom"); });
    await mount({ text: JSON.stringify(wf(["a"]), null, 2), onText: () => {}, validate });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(box.textContent).toContain("server check failed");
    expect(box.textContent).not.toContain("checking...");
    const retry = [...box.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("read-only shows the graph marked against the current revision, takes no edit, asks no check and lists no problems", async () => {
    vi.useFakeTimers();
    const validate = vi.fn(async () => ({ ok: true, issues: [], warnings: [] }));
    const onText = vi.fn();
    await mount({ text: JSON.stringify(wf(["a", "old"]), null, 2), onText, base: wf(["a"]), baseLabel: "rev 3, the current one", readOnly: true, validate });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(validate).not.toHaveBeenCalled();
    expect(box.textContent).toContain("Read-only");
    expect(box.textContent).toMatch(/1 new · 1 connection changed against rev 3, the current one/);
    expect(box.querySelector("svg")?.textContent).toMatch(/old[\s\S]*NEW/);
    const area = box.querySelector("textarea")!;
    expect(area.readOnly).toBe(true);
    await act(async () => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
    expect(onText).not.toHaveBeenCalled();
    expect(box.querySelector("[aria-label='Problems']")).toBeNull();
    expect(box.textContent).not.toMatch(/checking\.\.\.|checked by the server|Valid|server checks the workflow again when you save/);
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Retry");
  });
});
