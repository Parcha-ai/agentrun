// The stage's link to the agent's tab. The stage opens the tab with window.open and keeps the handle; the tab posts its events (`{source: "walks-home-tab", type, run, ...}`) to its opener with the
// stage's origin as the target, never "*"; the stage accepts a message only from the tab's origin AND the window it holds. It is all in-browser, so it keeps working when the network is off.
// After a stage reload the handle is gone: window.open("", name) returns the same tab without navigating it (window.open(url, name) would reload the tab and lose its state).
import { checkinFromData, homecomingFromData, homecomingLoadedFromData, netFromData, parseTabMessage, routingFromData, toolsFromData } from "../selftools.ts";
import type { ShowEvent } from "../types.ts";

/** The tab's URL with the stage's own origin as `stage=`: the page posts to its opener with exactly that origin. Only http and https; a `stage` that is not ours is replaced. */
export function tabUrlFor(tabUrl: string, stageOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.searchParams.set("stage", stageOrigin);
  return url.toString();
}

type TabMessage = NonNullable<ReturnType<typeof parseTabMessage>>;

/** The stage's events for one tab message, by its type; a type the stage does not use, or an event that lacks what it is about, is no event. */
export function tabEventsFrom(message: TabMessage, at: number): ShowEvent[] {
  const d = message.detail;
  switch (message.type) {
    case "net": {
      const net = netFromData(d);
      return net ? [{ t: "net", at, net }] : [];
    }
    case "checkin": {
      const checkin = checkinFromData(d);
      return checkin ? [{ t: "checkin", at, checkin }] : [];
    }
    case "brain": {
      const routing = routingFromData(d);
      return routing ? [{ t: "routing", at, routing }] : [];
    }
    case "tools": {
      const tools = toolsFromData(d);
      return tools ? [{ t: "tools", at, tools }] : [];
    }
    case "homecoming": {
      const loaded = homecomingLoadedFromData(d);
      if (loaded) return [{ t: "homecoming.loaded", at, loadMs: loaded.loadMs }];
      const homecoming = homecomingFromData(d);
      return homecoming ? [{ t: "homecoming", at, homecoming }] : [];
    }
    default:
      return [];
  }
}

export type TabLinkOptions = {
  win: Pick<Window, "open" | "origin">;
  tabUrl: string;
  /** The window name: the same name finds the same tab again after a reload. */
  name: string;
  onEvent?: (message: TabMessage) => void;
};

export class TabLink {
  private held: Window | null = null;
  private readonly tabOrigin: string | null;
  private readonly o: TabLinkOptions;

  constructor(o: TabLinkOptions) {
    this.o = o;
    try {
      this.tabOrigin = new URL(o.tabUrl).origin;
    } catch {
      this.tabOrigin = null;
    }
  }

  /** The stage holds a tab that is still open. */
  get attached(): boolean {
    return this.held !== null && !this.held.closed;
  }

  /** Opens the tab (a user gesture in a real browser) unless it is already held. */
  open(): boolean {
    if (this.attached) return true;
    const url = tabUrlFor(this.o.tabUrl, this.o.win.origin);
    if (url === null) return false;
    this.held = this.o.win.open(url, this.o.name);
    return this.attached;
  }

  /** After a stage reload: the named window, with an empty URL so it is not navigated. A window the browser made new for that name (there was no tab) is closed. */
  reattach(): boolean {
    const w = this.o.win.open("", this.o.name);
    if (!w) return false;
    try {
      // Readable means same-origin: a blank one the browser just made. A tab on another origin refuses the read, which is how it is told from a blank window.
      if (w.location.href === "about:blank") {
        w.close();
        return false;
      }
    } catch {
      // another origin: the tab
    }
    this.held = w;
    return this.attached;
  }

  /** A `message` event of the stage's window: the tab's, from the tab's origin and the window held, or nothing. */
  handle(e: MessageEvent): void {
    if (!this.attached || this.tabOrigin === null || e.origin !== this.tabOrigin || e.source !== this.held) return;
    const message = parseTabMessage(e.data);
    if (message !== null) this.o.onEvent?.(message);
  }
}
