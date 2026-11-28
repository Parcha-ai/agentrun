import { afterEach, describe, expect, it, vi } from "vitest";
import { goBack, trackHistory } from "@/lib/back";

// Back from a page opened from elsewhere (numbered 0) puts its parent in its place, still numbered 0, so the parent's own
// Back goes on to its parent and never returns to the page (history.back() from a pushed entry numbered 1 would loop).
describe("goBack", () => {
  let untrack = () => {};
  afterEach(() => { untrack(); vi.restoreAllMocks(); });

  it("opened from elsewhere, an editor's Back replaces it with its agent, and the agent's Back goes to the list, never back to the editor", () => {
    history.replaceState(null, "", "#/agents/a1/edit");
    untrack = trackHistory();
    const length = history.length;
    const back = vi.spyOn(history, "back");
    goBack("#/agents/a1");
    expect(location.hash).toBe("#/agents/a1");
    expect(history.length, "the agent page took the editor's entry, not a new one").toBe(length);
    expect((history.state as { console_at?: number }).console_at).toBe(0);
    goBack("#/agents");
    expect(location.hash).toBe("#/agents");
    expect(back, "nothing went back to the editor").not.toHaveBeenCalled();
  });

  it("after a move inside the console, Back is the browser's own", () => {
    history.replaceState(null, "", "#/agents");
    untrack = trackHistory();
    location.hash = "#/agents/a1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    goBack("#/agents");
    expect(back).toHaveBeenCalledOnce();
  });
});
