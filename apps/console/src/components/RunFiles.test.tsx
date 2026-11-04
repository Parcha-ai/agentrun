import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "./RunFiles";
import type { RunFile } from "@/lib/v2";

// The file viewer closes as the console's other overlays do: its X, a click on the dimmed backdrop around it, or Escape
// (the browser's cancel of a modal dialog). A click inside it, or a drag that starts inside and ends outside, keeps it.
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

  it("still closes with its X", () => {
    const { onClose, dialog } = viewer();
    act(() => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
