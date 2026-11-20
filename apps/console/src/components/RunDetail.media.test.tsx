import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run, RunFile } from "@/lib/v2";

// A run that made an image, a clip or a narration (a fal generation saved into its files) shows it in the file viewer
// from the run's file route. The bytes are never read as text: a video read through readFile would be megabytes of
// noise in a <pre>, and the viewer would show that instead of playing it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const f = runFixture("run.with-files");
const file = (path: string, content_type: string): RunFile => ({ path, size_bytes: 4096, modified_at: "2026-11-20T13:30:00.000Z", content_type });
const card = file("media/card.png", "image/png");
const voice = file("media/voice.mp3", "audio/mpeg");
const notes = file("notes.md", "text/markdown; charset=utf-8");
const files = [card, voice, notes];
const fileUrl = (path: string) => `/v2/runs/run_1/files/${path}`;

async function open(props: { openFile?: RunFile; withUrl?: boolean } = {}) {
  const readFile = vi.fn(async (r: RunFile) => `# ${r.path}`);
  const run = { ...f.run, status: "completed", state: "idle", result: { ...f.run.result, final_answer: "Made [the card](media/card.png), [the voice](media/voice.mp3) and [notes](notes.md)." } } as Run;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(RunDetail, { run, agentName: "maker", messages: messageFeatures, harnessSteers: true, rows: [], files, readFile, actions: {}, tab: "report", ...(props.withUrl === false ? {} : { fileUrl }), ...(props.openFile ? { openFile: props.openFile } : {}) }));
  });
  const click = async (text: string) => {
    const el = [...host.querySelectorAll("article.report a, article.report button")].find((e) => e.textContent === text)!;
    await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  };
  return { host, readFile, click };
}

describe("a run's media in the file viewer", () => {
  it("an image linked from the answer opens from its file URL, never read as text", async () => {
    const page = await open();
    await page.click("the card");
    expect(page.readFile).not.toHaveBeenCalled();
    expect(page.host.querySelector("dialog img")?.getAttribute("src")).toBe(fileUrl("media/card.png"));
  });

  it("a sound plays from its file URL", async () => {
    const page = await open();
    await page.click("the voice");
    expect(page.readFile).not.toHaveBeenCalled();
    const audio = page.host.querySelector("dialog audio");
    expect(audio?.getAttribute("src")).toBe(fileUrl("media/voice.mp3"));
    expect(audio?.hasAttribute("controls")).toBe(true);
  });

  it("a file opened from the page's address (openFile) that is media shows the same way", async () => {
    const page = await open({ openFile: card });
    expect(page.readFile).not.toHaveBeenCalled();
    expect(page.host.querySelector("dialog img")?.getAttribute("src")).toBe(fileUrl("media/card.png"));
  });

  it("text still reads as text", async () => {
    const page = await open();
    await page.click("notes");
    expect(page.readFile).toHaveBeenCalledWith(notes);
    expect(page.host.querySelector("dialog img")).toBeNull();
  });

  it("with no file route, media is read as before and offered as a download", async () => {
    const page = await open({ withUrl: false });
    await page.click("the card");
    expect(page.readFile).toHaveBeenCalledWith(card);
    expect(page.host.querySelector("dialog img")).toBeNull();
    expect(page.host.textContent).toContain("Download it to open it");
  });
});
