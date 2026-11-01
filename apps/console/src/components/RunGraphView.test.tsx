import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunGraph } from "@/components/RunGraphView";
import { ClientError } from "@/lib/client";
import type { RunGraph } from "@/lib/runGraph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); vi.useRealTimers(); document.body.innerHTML = ""; });

function Probe({ load, enabled = true }: { load: (s: AbortSignal) => Promise<RunGraph>; enabled?: boolean }) {
  useRunGraph(load, { everyMs: 1000, key: "r", enabled });
  return null;
}

describe("useRunGraph", () => {
  it("stops asking after a permanent refusal (a server without the route)", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new ClientError(404, "not_found", "no route"); });
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(createElement(Probe, { load })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("keeps asking after a refusal that can pass, and asks nothing when disabled", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new ClientError(503, "unavailable", "busy"); });
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(createElement(Probe, { load })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(load.mock.calls.length).toBeGreaterThan(2);
    const off = vi.fn(async () => ({}) as RunGraph);
    await act(async () => { root!.render(createElement(Probe, { load: off, enabled: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(off).not.toHaveBeenCalled();
  });
});
