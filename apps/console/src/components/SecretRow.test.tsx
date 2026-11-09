import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRow } from "./SecretRow";
import type { SecretField } from "@/lib/v2";

// One row for every secret the console holds a place for (Keys, MCP servers, and Computers through c1): its name, Set or
// Missing, where it comes from, when it last changed, and Paste / Replace / Remove only on the owner's password session
// (session.secrets_writable). A secret set in the environment wins and is greyed, with nothing to paste over it. No value
// is ever on the page: the read has none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const NOW = Date.parse("2026-11-09T12:00:00Z");
const field = (over: Partial<SecretField>): SecretField => ({ name: "PARALLEL_API_KEY", set: true, source: "console", changed_at: "2026-11-09T09:00:00Z", ...over });
function row(f: SecretField, writable: boolean) {
  const onPaste = vi.fn(), onRemove = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement("ul", null, createElement(SecretRow, { field: f, writable, now: () => NOW, onPaste, onRemove }))));
  const li = host.querySelector(`[data-secret="${f.name}"]`)!;
  const buttons = () => [...li.querySelectorAll("button")].map((b) => b.textContent?.trim());
  return { li, buttons, onPaste, onRemove, click: (label: string) => act(() => { [...li.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!.click(); }) };
}

describe("SecretRow", () => {
  it("a secret pasted here: Set, Pasted here, when it changed, and Replace and Remove on a password session", () => {
    const r = row(field({}), true);
    expect(r.li.textContent).toContain("PARALLEL_API_KEY");
    expect(r.li.textContent).toContain("Set");
    expect(r.li.textContent).toContain("Pasted here");
    expect(r.li.textContent).toContain("Changed 3 h ago");
    expect(r.buttons()).toEqual(["Replace", "Remove"]);
    r.click("Replace");
    expect(r.onPaste).toHaveBeenCalledTimes(1);
    r.click("Remove");
    expect(r.onRemove).toHaveBeenCalledTimes(1);
  });

  it("a missing secret: Missing, and Paste on a password session", () => {
    const r = row(field({ set: false, source: null, changed_at: null }), true);
    expect(r.li.textContent).toContain("Missing");
    expect(r.li.textContent).not.toContain("Changed");
    expect(r.buttons()).toEqual(["Paste"]);
  });

  it("a secret set in the environment: greyed, said so, and nothing to paste over it", () => {
    const r = row(field({ source: "env", changed_at: null }), true);
    expect(r.li.textContent).toContain("Set in the environment");
    expect(r.li.getAttribute("data-source")).toBe("env");
    expect(r.li.className).toContain("opacity-60");
    expect(r.buttons()).toEqual([]);
  });

  it("a secret from a sign-in says so", () => {
    expect(row(field({ name: "token", source: "sign-in" }), true).li.textContent).toContain("From sign-in");
  });

  it("not on a password session: the state only, no Paste, Replace or Remove", () => {
    expect(row(field({}), false).buttons()).toEqual([]);
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(row(field({ set: false, source: null, changed_at: null }), false).buttons()).toEqual([]);
  });
});
