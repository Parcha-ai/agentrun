import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunFiles } from "@/components/RunFiles";
import type { RunFile } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const file = (path: string, size_bytes = 100): RunFile => ({ path, size_bytes, content_type: "text/plain", modified_at: "2026-11-03T21:00:00Z" } as RunFile);
const open = (files: RunFile[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<RunFiles files={files} onOpen={() => {}} />));
  return host;
};
const listed = (host: HTMLElement) => [...host.querySelectorAll("li")].map((li) => li.textContent ?? "");
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

// A coding run leaves Python's caches and tool folders beside what it wrote. The Files tab lists what it wrote and keeps
// the rest behind "Show hidden".
describe("RunFiles, hidden folders", () => {
  const files = [file("stats.py"), file("__pycache__/stats.cpython-312.pyc"), file(".git/HEAD"), file("test_stats.py"), file("pkg/.pytest_cache/v/x"), file("web/node_modules/a/index.js")];

  it("lists what the run wrote, counts only that, and offers the rest", () => {
    const host = open(files);
    expect(listed(host)).toHaveLength(2);
    expect(host.textContent).not.toContain("__pycache__");
    expect(host.textContent).not.toContain(".git/HEAD");
    expect(host.textContent).toContain("2 files");
    expect(button(host, "Show 4 hidden")).toBeDefined();
  });

  it("shows them on asking, and hides them again", () => {
    const host = open(files);
    act(() => button(host, "Show 4 hidden")!.click());
    expect(listed(host)).toHaveLength(6);
    expect(host.textContent).toContain("__pycache__/stats.cpython-312.pyc");
    act(() => button(host, "Hide 4 hidden")!.click());
    expect(listed(host)).toHaveLength(2);
  });

  it("keeps a dot FILE the run wrote, and offers nothing when nothing is hidden", () => {
    const host = open([file(".env.example"), file("notes.md")]);
    expect(listed(host)).toHaveLength(2);
    expect(host.textContent).not.toMatch(/hidden/);
  });

  it("says so when every file is in a hidden folder", () => {
    const host = open([file("__pycache__/a.pyc")]);
    expect(host.textContent).toContain("Only files in hidden folders (1).");
    expect(button(host, "Show 1 hidden")).toBeDefined();
  });
});
