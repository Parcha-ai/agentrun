import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "./RunFiles";
import type { RunFile } from "@/lib/v2";

// The file viewer closes as the console's other overlays do: its X, a click on the dimmed backdrop around it, or Escape
// (the browser's cancel of the dialog). A click inside it, or a drag that starts inside and ends outside, keeps it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = { path: "notes/a.md", size_bytes: 2, modified_at: "2026-11-04T20:57:00Z", content_type: "text/markdown; charset=utf-8" } as RunFile;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function viewer() {
  const onClose = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ArtifactViewer, { file, text: "# A", onClose })));
  const dialog = host.querySelector("dialog")!;
  const press = (target: Element, up: Element = target) => act(() => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    up.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // A click goes to the nearest element both the press and the release were in.
    const both = target.contains(up) ? target : up.contains(target) ? up : dialog;
    both.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return { onClose, dialog, press };
}

describe("ArtifactViewer, closing", () => {
  it("closes on a click on the dimmed backdrop around the file", () => {
    const { onClose, dialog, press } = viewer();
    press(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, the browser's cancel of the dialog", () => {
    const { onClose, dialog } = viewer();
    act(() => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a click inside it: the file, its header, its footer", () => {
    const { onClose, dialog, press } = viewer();
    for (const el of [dialog.querySelector("article")!, dialog.querySelector("header")!, dialog.querySelector("footer")!]) press(el);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a selection dragged from inside the file is let go over the backdrop", () => {
    const { onClose, dialog, press } = viewer();
    press(dialog.querySelector("article")!, dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a press on the backdrop is let go inside the file", () => {
    const { onClose, dialog, press } = viewer();
    press(dialog, dialog.querySelector("article")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes with its X", () => {
    const { onClose, dialog } = viewer();
    act(() => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Rendered or Raw: a Markdown file opens rendered, anything else as its exact text (each line on its own line, in
// monospace), and a toggle switches either one both ways. A run's "Hello, world!\nGoodbye, world!" read as one line in
// Markdown: correct, but surprising without the raw text a click away.
describe("ArtifactViewer, Rendered or Raw", () => {
  const TWO = "Hello, world!\nGoodbye, world!";
  const at = (path: string, content_type: string | null) => ({ path, size_bytes: TWO.length, modified_at: "2026-11-04T20:57:00Z", content_type } as RunFile);
  function open(f: RunFile) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ArtifactViewer, { file: f, text: TWO, onClose: () => {} })));
    const view = () => host.querySelector('[role="radiogroup"][aria-label="View"]');
    const picked = () => view()?.querySelector<HTMLInputElement>("input:checked")?.value;
    const pick = (value: "rendered" | "raw") => act(() => { view()!.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click(); });
    const raw = () => host.querySelector("dialog pre")?.textContent;
    const rendered = () => host.querySelector("dialog article")?.textContent;
    return { picked, pick, raw, rendered };
  }

  it("opens a text file in Raw: each line on its own line", () => {
    const v = open(at("out/notes.txt", "text/plain; charset=utf-8"));
    expect(v.picked()).toBe("raw");
    expect(v.raw()).toBe(TWO);
    expect(v.rendered()).toBeUndefined();
  });

  it("opens a Markdown file Rendered", () => {
    const v = open(at("hello.md", "text/markdown; charset=utf-8"));
    expect(v.picked()).toBe("rendered");
    expect(v.rendered()).toContain("Hello, world!");
    expect(v.raw()).toBeUndefined();
  });

  it("switches a Markdown file to Raw and back", () => {
    const v = open(at("hello.md", "text/markdown; charset=utf-8"));
    v.pick("raw");
    expect(v.picked()).toBe("raw");
    expect(v.raw()).toBe(TWO);
    v.pick("rendered");
    expect(v.picked()).toBe("rendered");
    expect(v.rendered()).toContain("Goodbye, world!");
    expect(v.raw()).toBeUndefined();
  });

  it("switches a text file to Rendered and back", () => {
    const v = open(at("out/notes.txt", "text/plain"));
    v.pick("rendered");
    expect(v.picked()).toBe("rendered");
    expect(v.rendered()).toContain("Goodbye, world!");
    v.pick("raw");
    expect(v.raw()).toBe(TWO);
  });

  it("offers no toggle for a file it doesn't show", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ArtifactViewer, { file: at("photo.png", "image/png"), text: "", onClose: () => {} })));
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });
});

// On a phone (375 px) the header's one row can't hold the file's name, the Rendered / Raw toggle, Copy and Download: the
// toggle takes a row of its own below them under the sm breakpoint, so Copy and Download stay on screen.
describe("ArtifactViewer, on a narrow screen", () => {
  const md = { path: "hello.md", size_bytes: 30, modified_at: "2026-11-04T20:57:00Z", content_type: "text/markdown" } as RunFile;
  const header = () => { const html = renderToStaticMarkup(createElement(ArtifactViewer, { file: md, text: "# A", onClose: () => {} })); return html.slice(html.indexOf("<header"), html.indexOf("</header>")); };
  it("lets the header wrap, and gives the toggle a full row of its own, last, below sm", () => {
    const h = header();
    expect(/^<header class="([^"]*)"/.exec(h)![1].split(" ")).toContain("flex-wrap");
    const row = /<div class="([^"]*)"><div class="[^"]*" role="radiogroup" aria-label="View">/.exec(h);
    expect(row?.[1].split(" ")).toEqual(expect.arrayContaining(["basis-full", "order-last", "sm:basis-auto", "sm:order-none"]));
  });
});
