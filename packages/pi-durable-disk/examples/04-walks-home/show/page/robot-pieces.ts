// The robot demo's stage pieces, mounted by any stage page that has their elements (obsession/page and the v2 page): the net pill, the decision card, the check-in and homecoming lines, the
// robot-change card and the tool strip (the agent's tab's own events: robot-view.ts), the tab link (window.open, page/tab-link.ts) and the eight tiles with the one robot (threads-view.ts,
// D2's per-skill files read from the run's disk). A page that lacks an element skips that piece; with no tab and no threads every piece is empty.
import { changeCardHtml, checkinLine, checkinNote, fileChanges, homecomingLine, homecomingNote, netBadge, netNote, routingCardHtml, toolStripHtml } from "../robot-view.ts";
import { LandingDriver, threadsHtml } from "../threads-view.ts";
import type { Note, ShowState } from "../types.ts";
import { apiUrl } from "./api-base.ts";
import { esc } from "./dom.ts";
import type { Feed } from "./feed.ts";
import { RunScope } from "./run-scope.ts";
import { SkillsPoller } from "./skills-poller.ts";
import { TabLink, stageKeys, tabEventsFrom } from "./tab-link.ts";

const el = (id: string): HTMLElement | null => document.getElementById(id);
const storage = {
  get: (key: string): string | null => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // no storage: the page still works until it is reloaded
    }
  },
};

/** The session store for the tab's events, scoped to the run in the tab link: the Feed takes it so a reload keeps what the tab said. */
export function robotStore(keys: ReturnType<typeof stageKeys>): { get(): string | null; set(value: string): void } {
  return { get: () => storage.get(keys.eventsKey), set: (value) => storage.set(keys.eventsKey, value) };
}

export type RobotPieces = { frame(state: ShowState): void };

export function mountRobotPieces(o: { feed: Feed; params: URLSearchParams; api: string; keys: ReturnType<typeof stageKeys>; addNotes: (...notes: Note[]) => void }): RobotPieces {
  const { feed, params, api, keys, addNotes } = o;

  // ---- The agent's tab (the 03 page) when the stage is given one: ?tab=<its link>. Opened with window.open, the handle kept, its events taken by postMessage, all in the browser (so it works with
  // the network off); after a reload of this page the tab is found again by name, never navigated.
  /** Once the tab has said a skill is installed in the robot the stage does not make the skills land itself; a new run starts over. */
  const landing = new LandingDriver();
  const flag = (set?: boolean): boolean => {
    if (set !== undefined) storage.set(keys.flagKey, set ? "1" : "");
    return storage.get(keys.flagKey) === "1";
  };
  const tabUrl = params.get("tab");
  const link = tabUrl
    ? new TabLink({
        win: window,
        tabUrl,
        name: keys.windowName,
        run: keys.run,
        onEvent: (m) => {
          if (m.type === "skill-installed") landing.noteInstalled();
          // A skill going in is not a fact to keep across a reload (the tiles are read from the disk again); the rest are.
          for (const e of tabEventsFrom(m, feed.captionNow())) (m.type === "skill-installed" ? feed.fold(e) : feed.inject(e));
        },
      })
    : null;
  const button = el("opentab") as HTMLButtonElement | null;
  if (link && button) {
    window.addEventListener("message", (e) => link.handle(e));
    if (flag()) link.reattach();
    button.hidden = false;
    button.addEventListener("click", () => {
      if (link.open()) flag(true);
    });
  }

  // ---- One robot, eight teachers: D2's per-skill files from the run's disk, about once a second. A new feed (a reconnect, a new run) starts them over.
  const poller = new SkillsPoller({
    read: async (path) => {
      const res = await fetch(apiUrl(api, `api/disk/${path}`), { cache: "no-store" });
      return res.status === 200 ? await res.text() : undefined;
    },
    emit: (e) => feed.fold(e),
    now: () => feed.captionNow(),
  });
  // A new run (a retake, a reset, a new feed) starts all of this over, at the moment the feed says so: a word from the tab right after belongs to the new run.
  const scope = new RunScope();
  scope.onReset(() => {
    poller.reset();
    landing.reset();
    said.clear();
  });
  feed.onChange(() => scope.sync(feed.generation));
  setInterval(() => {
    scope.sync(feed.generation);
    void poller.tick().catch(() => undefined);
  }, 1000);
  // With no word from the tab about skills going in, they land in the robot one after another once every thread has finished and the run is home.
  setInterval(() => {
    const id = landing.next(feed.state.threads, feed.state.place.where === "home");
    if (id) feed.fold({ t: "thread", at: feed.captionNow(), id, patch: { home: true } });
  }, 450);

  // ---- Rendering and captions.
  const said = new Set<string>();
  const once = (key: string): boolean => (said.has(key) ? false : (said.add(key), true));
  let sideKey = "";
  let threadsKey = "";

  function renderSide(state: ShowState): void {
    const net = netBadge(state.net);
    const lines = [checkinLine(state.checkin), homecomingLine(state.homecoming)];
    const card = changeCardHtml(fileChanges(state.tools), state.net, state.routing) + (state.routing ? routingCardHtml(state.routing) : "");
    const tools = toolStripHtml(state.tools);
    const key = JSON.stringify([net, lines, card, tools, state.checkin?.phase]);
    if (key === sideKey) return;
    sideKey = key;
    const pill = el("net");
    if (pill) {
      pill.hidden = net === null;
      if (net) {
        pill.textContent = net.label;
        pill.dataset.online = String(net.online);
        pill.title = net.title;
      }
    }
    const side = el("robotside");
    if (side) side.innerHTML = card + lines.map((l, i) => (l === null ? "" : `<div class="line${i === 0 && state.checkin?.phase === "failed" ? " bad" : ""}">${esc(l)}</div>`)).join("");
    const strip = el("toolstrip");
    if (strip) {
      strip.hidden = tools === "";
      strip.innerHTML = tools;
    }
  }

  function renderThreads(state: ShowState): void {
    const html = threadsHtml(state.threads);
    if (html === threadsKey) return;
    threadsKey = html;
    const box = el("threads");
    if (!box) return;
    box.hidden = html === "";
    box.innerHTML = html;
  }

  /** The captions of the tab's own events, each said once: a net change, a finished check-in, a homecoming's bytes. */
  function notes(state: ShowState): void {
    if (state.net && once(`net|${state.net.at}|${state.net.online}`)) addNotes(netNote(state.net, feed.captionNow()));
    if (state.checkin && once(`checkin|${state.checkin.at}|${state.checkin.phase}`)) {
      const n = checkinNote(state.checkin, feed.captionNow());
      if (n) addNotes(n);
    }
    if (state.homecoming && !state.homecoming.prefetch && once(`homecoming|${state.homecoming.at}`)) {
      const n = homecomingNote(state.homecoming, feed.captionNow(), state.source === "live");
      if (n) addNotes(n);
    }
  }

  return {
    frame(state) {
      notes(state);
      renderSide(state);
      renderThreads(state);
    },
  };
}
