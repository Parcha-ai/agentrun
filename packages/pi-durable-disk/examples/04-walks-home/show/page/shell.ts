// The bridge to the embedded tab app (D3). Same origin, an agreed envelope, and three checks on every inbound message:
// the origin is ours, the sender is the iframe's own window, and the envelope namespace matches.
import type { ShellToTab, TabToShell } from "../types.ts";

type Distribute<T> = T extends unknown ? Omit<T, "ns"> : never;

export class TabBridge {
  ready = false;
  private frame: HTMLIFrameElement;
  private onReadyFns: (() => void)[] = [];
  private handlers = new Set<(m: TabToShell) => void>();

  constructor(frame: HTMLIFrameElement) {
    this.frame = frame;
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.source !== this.frame.contentWindow) return;
      const m = e.data as TabToShell | null;
      if (!m || typeof m !== "object" || m.ns !== "walks-home" || typeof m.type !== "string") return;
      if (m.type === "ready") {
        this.ready = true;
        for (const fn of this.onReadyFns) fn();
      }
      for (const h of this.handlers) h(m);
    });
    // A reload of the frame is a fresh app that must say ready again.
    this.frame.addEventListener("load", () => {
      this.ready = false;
    });
  }

  onReady(fn: () => void): void {
    this.onReadyFns.push(fn);
    if (this.ready) fn();
  }

  onMessage(fn: (m: TabToShell) => void): void {
    this.handlers.add(fn);
  }

  send(message: Distribute<ShellToTab>): void {
    this.frame.contentWindow?.postMessage({ ns: "walks-home", ...message }, location.origin);
  }
}
