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
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(<RunFiles files={files} onOpen={() => {}} />));
  return el;
};
const paths = (el: HTMLElement) => [...el.querySelectorAll("li")].map((li) => li.textContent ?? "");

// A coding run leaves Python's caches and tool folders beside what it wrote. The Files tab lists what it wrote and keeps
// the rest behind "Show hidden".
describe("RunFiles, hidden folders", () => {
  const files = [file("stats.py"), file("__pycache__/stats.cpython-312.pyc"), file(".git/HEAD"), file("test_stats.py"), file("pkg/.pytest_cache/v/x")];

  it("lists what the run wrote, counts only that, and offers the rest", () => {
    const el = open(files);
    expect(paths(el)).toHaveLength(2);
    expect(el.textContent).toContain("stats.py");
    expect(el.textContent).not.toContain("__pycache__");
    expect(el.textContent).not.toContain(".git/HEAD");
    expect(el.textContent).toContain("2 files");
    expect(el.textContent).toContain("Show 3 hidden");
  });

  it("shows them on asking, and hides them again", () => {
    const el = open(files);
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Show 3 hidden")!.click());
    expect(paths(el)).toHaveLength(5);
    expect(el.textContent).toContain("__pycache__/stats.cpython-312.pyc");
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Hide 3 hidden")!.click());
    expect(paths(el)).toHaveLength(2);
  });

  it("keeps a dot FILE the run wrote, and offers nothing when nothing is hidden", () => {
    const el = open([file(".env.example"), file("notes.md")]);
    expect(paths(el)).toHaveLength(2);
    expect(el.textContent).not.toMatch(/hidden/);
  });

  it("says so when every file is in a hidden folder", () => {
    const el = open([file("__pycache__/a.pyc")]);
    expect(el.textContent).toContain("Only files in hidden folders");
    expect(el.textContent).toContain("Show 1 hidden");
  });
});
