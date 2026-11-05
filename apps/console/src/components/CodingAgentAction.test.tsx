import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentAction } from "./CodingAgentAction";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });
const prompt = "Import existing local sessions; do not start a paid run.";
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string) => buttons().find((b) => b.textContent === text)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const key = (element: HTMLElement, value: string) => act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
function mount(two = false) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement("div", null,
    createElement(CodingAgentAction, { label: "Import agents", prompt, playgroundHref: "#/playground" }),
    two && createElement(CodingAgentAction, { label: "Query", prompt }))));
  return host;
}
function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

describe("CodingAgentAction", () => {
  it("renders the closed control statically without layout-effect warnings", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(renderToStaticMarkup(createElement(CodingAgentAction, { label: "Import agents", prompt }))).toContain("Import agents");
    expect(error).not.toHaveBeenCalled();
  });

  it("asks for a first preference, remembers it across actions and reloads, and only copies on explicit action", async () => {
    const write = clipboard();
    mount(true);
    await click(button("Import agents"));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(button("Claude Code CLI"));
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(CODING_AGENT_PREFERENCE)).toBe("claude-cli");
    expect(button("Query").title).toBe("Copy prompt for Claude Code CLI");
    await click(button("Import agents"));
    expect(write).toHaveBeenCalledWith(prompt);
    act(() => root!.unmount());
    mount();
    expect(button("Import agents").title).toBe("Copy prompt for Claude Code CLI");
    expect(document.querySelector('[download]')).toBeNull();
  });

  it("opens app prompts through an encoded link and offers playground plus copy in the menu", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex");
    mount();
    const link = document.querySelector<HTMLAnchorElement>('a[title="Open in Codex app"]')!;
    expect(new URL(link.href).searchParams.get("prompt")).toBe(prompt);
    await click(document.querySelector('[aria-label="Choose coding agent for Import agents"]')!);
    expect(document.querySelector('a[href="#/playground"]')?.textContent).toBe("API playground");
    expect(button("Copy prompt")).toBeTruthy();
  });

  it("supports keyboard selection, escape, and outside dismissal", async () => {
    mount();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Import agents"]')!;
    await click(trigger);
    expect(document.activeElement?.textContent).toBe("Codex app");
    key(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Codex CLI");
    key(document.activeElement as HTMLElement, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click(trigger);
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps the full prompt available when clipboard access is refused", async () => {
    clipboard(vi.fn().mockRejectedValue(new Error("refused")));
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
    mount();
    await click(button("Import agents"));
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt to copy"]')!;
    expect(field.value).toBe(prompt);
    expect(document.activeElement).toBe(field);
    key(field, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("focuses the remembered choice and synchronizes preference changes from another tab", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "claude-cli");
    mount();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Import agents"]')!;
    await click(trigger);
    expect(document.activeElement?.textContent).toBe("Claude Code CLI");
    key(document.activeElement as HTMLElement, "Escape");
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: CODING_AGENT_PREFERENCE, newValue: "codex-cli" })));
    expect(button("Import agents").title).toBe("Copy prompt for Codex CLI");
  });

  it("shares the choice for this visit even when local storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount(true);
    await click(button("Import agents"));
    await click(button("Codex CLI"));
    expect(button("Query").title).toBe("Copy prompt for Codex CLI");
  });

  it("keeps compact card actions named and functional", async () => {
    const write = clipboard();
    localStorage.setItem(CODING_AGENT_PREFERENCE, "claude-cli");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(CodingAgentAction, { label: "Run agent", prompt, compact: true })));
    const action = host.querySelector<HTMLButtonElement>('button[aria-label="Run agent"]')!;
    expect(action.title).toBe("Run agent · Copy prompt for Claude Code CLI");
    expect(action.querySelector(".sr-only")?.textContent).toBe("Run agent");
    await click(action);
    expect(write).toHaveBeenCalledWith(prompt);
  });
});
