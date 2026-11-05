import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import { markdown } from "@/lib/format";
import type { Run, RunFile } from "@/lib/v2";

// A link in a run's answer is resolved by the browser against the console's own page, so a relative one (the file an
// agent wrote, linked by its name) used to send the console's tab to a server path that is no page at all. A link that
// names one of the run's files opens it in the run's file viewer; any other relative link reads as its text and goes
// nowhere; a link to a site is as it was.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const f = runFixture("run.with-files");
const file = (path: string, content_type: string | null = "text/markdown; charset=utf-8"): RunFile => ({ path, size_bytes: 12, modified_at: "2026-11-04T12:00:00.000Z", content_type });
const files = [file("hello.md"), file("notes/plan.md"), file("notes#1/plan.md"), file("notes#1/other.md"), file("notes/log.txt", "text/plain; charset=utf-8")];
const answer = "I wrote [hello.md](hello.md). See also [x](other/missing.md), [top](#top) and [site](https://example.com).";

async function open(final_answer: string, readFile = vi.fn(async (r: RunFile) => `# ${r.path}\n\nSee [hello.md](../hello.md).`)) {
  const run = { ...f.run, status: "completed", state: "idle", result: { ...f.run.result, final_answer } } as Run;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(RunDetail, { run, agentName: "writer", messages: messageFeatures, harnessSteers: true, rows: [], files, readFile, actions: {}, tab: "report" }));
  });
  const report = () => host.querySelector("article.report") as HTMLElement;
  const named = (text: string) => [...report().querySelectorAll("a, button")].find((e) => e.textContent === text) as HTMLElement | undefined;
  const click = async (el: Element) => {
    let ev!: MouseEvent;
    await act(async () => { ev = new MouseEvent("click", { bubbles: true, cancelable: true }); el.dispatchEvent(ev); });
    return ev;
  };
  return { host, report, named, click, readFile };
}

describe("a link in a run's answer", () => {
  it("one that names a run file opens that file in the viewer, and is no link the browser would follow", async () => {
    const page = await open(answer);
    expect(page.report().querySelector('a[href="hello.md"]')).toBeNull();
    const before = location.href;
    const link = page.named("hello.md");
    expect(link, "the file's name is still there to click").toBeTruthy();
    expect(link!.hasAttribute("href")).toBe(false);
    await page.click(link!);
    expect(location.href).toBe(before);
    expect(page.readFile).toHaveBeenCalledWith(files[0]);
    expect(page.host.querySelector("dialog[aria-label='hello.md']")).not.toBeNull();
  });

  it("a relative one that names no run file, or a fragment, reads as its text and goes nowhere", async () => {
    const page = await open(answer);
    for (const href of ["other/missing.md", "#top"]) expect(page.report().querySelector(`[href="${href}"]`), href).toBeNull();
    expect(page.report().textContent).toContain("See also x, top and site.");
    const before = location.href;
    for (const text of ["x", "top"]) {
      const el = page.named(text);
      if (el) await page.click(el);
    }
    expect(location.href).toBe(before);
    expect(page.readFile).not.toHaveBeenCalled();
    expect(page.host.querySelector("dialog")).toBeNull();
  });

  it("a link to a site opens in a new tab, with no opener and no referrer, and never in the console's", async () => {
    const page = await open(answer + " And [plain](http://example.com/a).");
    for (const href of ["https://example.com", "http://example.com/a"]) {
      const site = page.report().querySelector(`a[href="${href}"]`);
      expect(site, href).not.toBeNull();
      expect(site!.getAttribute("target"), href).toBe("_blank");
      expect(site!.getAttribute("rel"), href).toBe("noopener noreferrer");
    }
  });

  it("a ./ path names the run file too, and a path in a folder names the file at that path", async () => {
    const page = await open("Both: [a](./hello.md) and [b](notes/plan.md).");
    await page.click(page.named("b")!);
    expect(page.readFile).toHaveBeenCalledWith(files[1]);
    expect(page.report().querySelector('a[href="./hello.md"]')).toBeNull();
    expect(page.named("a")?.hasAttribute("href")).toBe(false);
  });

  it("in the viewer, a Markdown file's link to another run file opens that one, resolved from the file's folder", async () => {
    const page = await open("Read [the plan](notes/plan.md).");
    await page.click(page.named("the plan")!);
    const dialog = () => page.host.querySelector("dialog") as HTMLElement;
    expect(dialog().getAttribute("aria-label")).toBe("notes/plan.md");
    const inside = [...dialog().querySelectorAll("article button, article a")].find((e) => e.textContent === "hello.md");
    expect(inside?.hasAttribute("href")).toBe(false);
    await page.click(inside!);
    expect(page.readFile).toHaveBeenLastCalledWith(files[0]);
    expect(page.host.querySelector("dialog")?.getAttribute("aria-label")).toBe("hello.md");
  });
});

describe("a link no URL parser takes", () => {
  it("reads as its text, and the answer still renders, with the run's files given", async () => {
    const page = await open('Before <a href="\\\\[">broken</a> after, and [hello.md](hello.md).');
    expect(page.report().textContent).toContain("Before broken after");
    expect(page.report().querySelector("a")).toBeNull();
    expect(page.named("hello.md")?.tagName).toBe("BUTTON");
  });
});

describe("a folder name a URL would read as syntax", () => {
  it("a Markdown file in notes#1/ opens its sibling other.md as notes#1/other.md", async () => {
    const readFile = vi.fn(async (r: RunFile) => (r.path === "notes#1/plan.md" ? "See [other](other.md)." : `# ${r.path}`));
    const page = await open("Read [the plan](notes%231/plan.md).", readFile);
    await page.click(page.named("the plan")!);
    expect(readFile).toHaveBeenLastCalledWith(files[2]);
    const inside = [...(page.host.querySelector("dialog") as HTMLElement).querySelectorAll("article button")].find((e) => e.textContent === "other");
    expect(inside, "the sibling is a run file's button").toBeTruthy();
    await page.click(inside!);
    expect(readFile).toHaveBeenLastCalledWith(files[3]);
    expect(page.host.querySelector("dialog")?.getAttribute("aria-label")).toBe("notes#1/other.md");
  });
});

// The viewer's Rendered / Raw starts from the file's kind (Markdown Rendered, other text Raw). A link moves the viewer to
// another file in place, so the new file starts from its own kind, not from the one before it.
describe("a link in the viewer, Rendered or Raw", () => {
  const PLAN = "See [the log](log.txt) and [hello.md](../hello.md).";
  const readFile = () => vi.fn(async (r: RunFile) => (r.path === "notes/plan.md" ? PLAN : r.path === "notes/log.txt" ? "line one\nline two" : `# ${r.path}`));
  async function plan() {
    const page = await open("Read [the plan](notes/plan.md).", readFile());
    await page.click(page.named("the plan")!);
    const dialog = () => page.host.querySelector("dialog") as HTMLElement;
    const picked = () => dialog().querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="View"] input:checked')?.value;
    const inside = (text: string) => [...dialog().querySelectorAll("article button")].find((e) => e.textContent === text) as HTMLElement | undefined;
    return { ...page, dialog, picked, inside };
  }

  it("a Markdown file's link to a run text file opens it in Raw", async () => {
    const v = await plan();
    expect(v.picked()).toBe("rendered");
    await v.click(v.inside("the log")!);
    expect(v.readFile).toHaveBeenLastCalledWith(files[4]);
    expect(v.dialog().getAttribute("aria-label")).toBe("notes/log.txt");
    expect(v.picked()).toBe("raw");
    expect(v.dialog().querySelector("pre")?.textContent).toBe("line one\nline two");
    expect(v.dialog().querySelector("article")).toBeNull();
  });

  it("a Markdown file's link to another Markdown file stays Rendered", async () => {
    const v = await plan();
    await v.click(v.inside("hello.md")!);
    expect(v.dialog().getAttribute("aria-label")).toBe("hello.md");
    expect(v.picked()).toBe("rendered");
    expect(v.dialog().querySelector("article")).not.toBeNull();
  });

  it("a Markdown file in Raw shows its links as typed, with nothing to click", async () => {
    const v = await plan();
    await act(async () => { v.dialog().querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="View"] input[value="raw"]')!.click(); });
    expect(v.dialog().querySelector("pre")?.textContent).toBe(PLAN);
    expect(v.dialog().querySelector("[data-run-file], a")).toBeNull();
  });
});

describe("markdown with no run files (a note, an editor preview)", () => {
  it("keeps no relative link: each reads as its text", () => {
    const html = markdown("[a](hello.md) [b](/v2/x) [c](#top) [d](//example.com/x) [e](https://example.com) [f](mailto:a@example.com)");
    expect(html).not.toMatch(/href="(hello\.md|\/v2\/x|#top|\/\/example\.com\/x)"/);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">e</a>');
    expect(html).toContain('<a href="mailto:a@example.com">f</a>');
    expect(html.replace(/<[^>]+>/g, "").trim()).toBe("a b c d e f");
  });
});
