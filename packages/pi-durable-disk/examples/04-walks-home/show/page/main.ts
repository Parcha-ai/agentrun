import type { HostKind, Note, ShowCommand, ShowEvent, ShowState, TabKind, TabToShell } from "../types.ts";
import { $, clock, esc, usd } from "./dom.ts";
import { badgeFor, MEMORY_LINE, trackFor } from "./badge.ts";
import { CaptionDesk, captionsFor } from "./caption.ts";
import { syncChat } from "./chat.ts";
import { bannerState, DiskProbe, proofLine, trimMeter, walkedOver10 } from "./offline.ts";
import { learningStartedNote, setupCaption } from "./setup.ts";
import { chartPoints, sparklineSvg } from "./sparkline.ts";
import { plainSwitch, simulationNote, storyNotes, visibleTag, wentAway } from "./story-notes.ts";
import { TakeMemory } from "./take-memory.ts";
import { cardShown, cardTag, cardVisible, decisionCardHtml } from "./decision-card.ts";
import { DesktopView } from "./desktop.ts";
import { Feed } from "./feed.ts";
import { Grid } from "./grid.ts";
import { TabBridge } from "./shell.ts";
import { notesFromTabEvent } from "./tab-notes.ts";
import { renderTimeline } from "./timeline.ts";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
// v2 is the default: the creature, one badge, the chat, one caption. ?debug=1 brings back the timeline, log, HUD, cost meter, multiverse,
// VM desktop and buttons (the take's operator panel stays on the `o` key either way).
const debug = params.get("debug") === "1";
document.body.classList.toggle("v2", !debug);
$<HTMLIFrameElement>("tab").src = debug ? "/tab/" : "/tab/?clean=1&banner=1";

const feed = new Feed();
const bridge = new TabBridge($<HTMLIFrameElement>("tab"));
const desktop = new DesktopView($("desktop"));
const grid = new Grid($("grid"), $("strip"), (id) => void kill(id));
const visited = new Set<string>();
let lastPlacement = "";
/** What the page remembers about the take on screen, all of it resetting together when the feed starts over (page/take-memory.ts). */
const memory = new TakeMemory();

// The tab app names its placements tab | daytona | gpu | vm; a feed's environments are told apart by their kind, not their id.
const TAB_KIND: Record<HostKind, TabKind> = { tab: "tab", sandbox: "daytona", vm: "vm", gpu: "gpu", pipe: "tab" };

async function kill(id: string): Promise<void> {
  const r = await feed.command({ t: "kill", universe: id });
  if (!r.ok) tabEvent(`kill refused: ${r.message ?? "?"}`);
}

function leader(state: ShowState) {
  return Object.values(state.universes)
    .filter((u) => u.status === "training" && u.slot !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

$("killone").addEventListener("click", () => {
  const l = leader(feed.state);
  if (l) void kill(l.id);
});
$("kick").addEventListener("click", () => bridge.send({ type: "kick", dir: [1, 0], force_n: 60 }));
$("memory").addEventListener("click", () => bridge.send({ type: "open-memory" }));

let tabLine: string[] = [];
function tabEvent(text: string): void {
  tabLine = [...tabLine.slice(-2), text];
  $("tabevents").textContent = tabLine.join("  |  ");
}

/** The tab's memory files live on the stage's disk (server side), so a reload of the page keeps the creature. */
async function answerStorage(m: Extract<TabToShell, { type: "storage-read" | "storage-write" }>): Promise<void> {
  const url = `/api/disk/${m.path.split("/").map(encodeURIComponent).join("/")}`;
  /** The stage's own words for why the disk said no (its JSON {error}), else the status. */
  const why = async (res: Response) => ((await res.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
  try {
    if (m.type === "storage-read") {
      // A poller passes the etag it last saw; the stage answers 304 instead of the bytes when nothing changed.
      const res = await fetch(url, { cache: "no-store", headers: m.ifNoneMatch ? { "if-none-match": m.ifNoneMatch } : {} });
      if (res.status === 304) return bridge.send({ type: "storage-result", id: m.id, bytes: null, notModified: true, etag: res.headers.get("etag") ?? m.ifNoneMatch });
      if (res.status === 204 || res.status === 404) return bridge.send({ type: "storage-result", id: m.id, bytes: null });
      if (!res.ok) throw new Error(await why(res));
      const etag = res.headers.get("etag");
      return bridge.send({ type: "storage-result", id: m.id, bytes: new Uint8Array(await res.arrayBuffer()), ...(etag ? { etag } : {}) });
    }
    // The write is acknowledged only after the disk has it: the tab treats the ack as durability.
    const res = await fetch(url, { method: "PUT", body: m.bytes as BodyInit });
    // 409: another machine holds the run. The tab keeps the design and asks the agent (design-request) instead of losing it.
    if (res.status === 409) return bridge.send({ type: "storage-written", id: m.id, error: "not-holder" });
    if (!res.ok) throw new Error(await why(res));
    bridge.send({ type: "storage-written", id: m.id });
    tabEvent(`disk write ${m.path} ${m.bytes.byteLength} B`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (m.type === "storage-read") bridge.send({ type: "storage-result", id: m.id, bytes: null, error: message });
    else bridge.send({ type: "storage-written", id: m.id, error: message });
  }
}

// What the tab reports about a policy coming home, as narration on the page's own clock, next to the feed's notes. These are
// real even when the feed is the scripted one, so they carry their own origin and basis (see tab-notes.ts).
/** The feed's notes and the tab's, in time order, as one state for captions and the narration column. */
function withTabNotes(state: ShowState): ShowState {
  const notes = debug ? state.notes : state.notes.map(plainSwitch);
  return memory.notes.length === 0 && notes === state.notes ? state : { ...state, notes: [...notes, ...memory.notes].sort((a, b) => a.at - b.at) };
}


// The stage's own captions (page/story-notes.ts): said once each, so a retake starts them over.
let simulationSaid = false;
/** The setups whose end has been said (by their start time): the counter stops and one line says how long it took. */
const setupNoted = memory.setupNoted;
/** A setup is told apart by its start time within one generation of the feed: a timeline that starts over reuses start times. */
const setupKey = (startedAt: number) => `${feed.generation}|${startedAt}`;
function endSetup(endedAt: number): void {
  const s = feed.state.setup;
  if (!s || setupNoted.has(setupKey(s.startedAt))) return;
  setupNoted.add(setupKey(s.startedAt));
  addNotes(learningStartedNote(s, endedAt, feed.state.source, endedAt));
}

/**
 * Notes for the take on screen, added through the take's memory. The memory syncs to the feed's generation first, so a note for a take that has just
 * started over (a setup that ended the moment after a reconnect, a trained brain landing between two frames) is kept, and what the old take left
 * behind is cleared. A take that starts over says its opening caption again.
 */
function addNotes(...notes: Note[]): void {
  const restarted = memory.add(feed.generation, ...notes);
  if (restarted && !debug && bridge.ready && simulationSaid) memory.add(feed.generation, simulationNote(feed.captionNow()));
}
/** Brings the take's memory up to the feed's generation (no notes to add). Called at the start of every feed and tab callback and each frame. */
const syncTake = (): void => addNotes();

bridge.onMessage((m: TabToShell) => {
  if (m.type === "storage-read" || m.type === "storage-write") return void answerStorage(m);
  syncTake();
  // Everything the creature does is a physics simulation: said once, in words, instead of a SIMULATED pill on every number.
  if (m.type === "ready" && !debug && !simulationSaid) {
    simulationSaid = true;
    addNotes(simulationNote(feed.captionNow()));
  }
  if (m.type === "policy-arrived" && m.kind) {
    memory.lastInstallKind = m.kind;
    if (m.checkpoint_n !== undefined) memory.installKind.set(m.checkpoint_n, m.kind);
  }
  // A trained brain installed in the tab is the evidence "Done training" rests on.
  if (m.type === "policy-arrived" && m.kind === "final") memory.story.trained = true;
  // The first checkpoint to reach the tab is where learning starts: the setup counter stops there.
  if (!debug && (m.type === "checkpoint-installed" || (m.type === "policy-arrived" && m.kind === "checkpoint"))) endSetup(feed.captionNow());
  const kind = m.type === "policy-walked" ? (m.checkpoint_n !== undefined ? memory.installKind.get(m.checkpoint_n) : memory.lastInstallKind) : undefined;
  // The tab says when the first stroke is drawn (once per page): the chat's prompt to draw is no longer needed.
  if ((m as unknown as { type: string }).type === "draw-started") memory.drawStarted = true;
  // A kick starts the window in which the getup lines are told.
  if (m.type === "kicked") memory.lastKickAt = feed.captionNow();
  // The tab's walk-meter (about 1 Hz): the straight-line distance from where the current version started. Taken after the network goes off, it is how far
  // the creature walked offline, over its last 10 simulated seconds of one version.
  const raw = m as unknown as { type: string; t?: unknown; metres?: unknown; version?: unknown };
  if (raw.type === "walk-meter" && typeof raw.t === "number" && typeof raw.metres === "number" && typeof raw.version === "number") {
    memory.meterSeen = true;
    if (offline && !memory.offlineSaid) {
      memory.meterOffline = trimMeter([...memory.meterOffline, { t: raw.t, metres: raw.metres, version: raw.version }]);
      const walked = walkedOver10(memory.meterOffline);
      if (walked !== null) {
        memory.offlineSaid = true;
        addNotes({ at: feed.captionNow(), kind: "home", text: `Still walking offline: ${walked.toFixed(1)} m in 10 s`, basis: "simulated", rank: 2, group: "offline" });
      }
    }
    return;
  }
  // Each version's distance in the fixed 10 s window its own file reports: the sparkline's points (and its caption's number).
  if (m.type === "policy-arrived" && m.reported_walk_10s_m != null && m.checkpoint_n !== undefined) memory.addVersion(m.checkpoint_n, m.reported_walk_10s_m);
  addNotes(...notesFromTabEvent(m, feed.captionNow(), { plain: !debug, ...(kind ? { kind } : {}), afterKick: memory.lastKickAt !== null && feed.captionNow() - memory.lastKickAt < 15_000 }));
  const detail = Object.entries(m)
    .filter(([k]) => k !== "ns" && k !== "type")
    .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v as number) : String(v).slice(0, 14)}`)
    .join(" ");
  tabEvent(`${m.type} ${detail}`.trim());
});

/** Tell the tab app where it is running; it shows its own "running in X" badge and never owns the switcher. */
function sendPlacement(state: ShowState): void {
  const env = state.currentEnv;
  if (!env || !bridge.ready) return;
  const label = state.environments.find((e) => e.id === env)?.label ?? env;
  const key = `${env}|${"host" in state.place ? state.place.host : ""}`;
  if (key === lastPlacement) return;
  lastPlacement = key;
  bridge.send({ type: "set-placement", kind: TAB_KIND[state.environments.find((e) => e.id === env)?.kind ?? "tab"], label: "host" in state.place && state.place.host ? state.place.host : label, since: Date.now() });
}

bridge.onReady(() => {
  lastPlacement = "";
  phaseSent = "";
  sendPlacement(feed.state);
  maybeSendPolicy(feed.state);
});

/** The winner's policy goes to the tab once, when the run is home. D2 writes it as work/home/policy.json (mlp-v1 JSON); the stage serves it at /policy/home.json from POLICY_DIR. */
function maybeSendPolicy(state: ShowState): void {
  // The run's own record counts too: a page that connects when the run is already home has seen nothing of the trip.
  if (wentAway(state)) memory.wasAway = true;
  // The v2 rehearsal has no pipe and no disk to carry a trained policy home, so the stage hands the tab its own file once the run is back.
  // A live take never does this: its policy arrives on the disk, and the tab's own watcher installs it.
  if (!debug && state.source === "scripted" && state.place.where === "home" && memory.wasAway && bridge.ready && memory.policyRequested !== "rehearsal") {
    memory.policyRequested = "rehearsal";
    bridge.send({ type: "load-policy", url: "/policy/home.json" });
    return;
  }
  if (state.place.where !== "home" || !bridge.ready) return;
  const winner = Object.values(state.universes).find((u) => u.status === "winner");
  if (!winner || memory.policyRequested === winner.id) return;
  memory.policyRequested = winner.id;
  bridge.send({ type: "load-policy", url: "/policy/home.json" });
}

/**
 * The switcher always names four targets: the tab, a basic sandbox, a VM and a GPU. A target the feed lists is a button;
 * one it does not is shown greyed, wired by name, and lights up when a live endpoint is handed over.
 */
const NAMED: { kind: HostKind; label: string }[] = [
  { kind: "tab", label: "Tab" },
  { kind: "sandbox", label: "Basic sandbox" },
  { kind: "vm", label: "VM" },
  { kind: "gpu", label: "GPU" },
];
function switcherSlots(state: ShowState): { id: string; label: string; kind: HostKind; wired: boolean }[] {
  const slots = state.environments.map((e) => ({ id: e.id, label: e.label, kind: e.kind, wired: true }));
  for (const n of NAMED) if (!state.environments.some((e) => e.kind === n.kind)) slots.push({ id: `unwired:${n.kind}`, label: n.label, kind: n.kind, wired: false });
  return slots;
}

function renderChrome(state: ShowState): void {
  $("run").textContent = state.run;
  $("source").hidden = state.source !== "scripted";
  const sw = $("switcher");
  const slots = switcherSlots(state);
  const sig = slots.map((e) => `${e.id}:${e.wired}`).join();
  if (sw.dataset.sig !== sig) {
    sw.dataset.sig = sig;
    sw.innerHTML = slots
      .map((e) =>
        e.wired
          ? `<button data-env="${esc(e.id)}" data-kind="${esc(e.kind)}"><span class="dot"></span>${esc(e.label)}</button>`
          : `<button class="unwired" data-kind="${esc(e.kind)}" disabled title="${esc(e.label)} is wired by name. It lights up when a live endpoint is handed over."><span class="dot"></span>${esc(e.label)}</button>`,
      )
      .join("");
    sw.querySelectorAll<HTMLButtonElement>("button[data-env]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await feed.command({ t: "switch", to: b.dataset.env! });
        if (!r.ok) tabEvent(`switch refused: ${r.message ?? "?"}`);
      }),
    );
  }
  if (state.currentEnv) visited.add(state.currentEnv);
  const moving = state.place.where === "moving" ? state.place.to : null;
  sw.querySelectorAll<HTMLButtonElement>("button[data-env]").forEach((b) => {
    const env = state.environments.find((e) => e.id === b.dataset.env);
    b.classList.toggle("active", state.currentEnv === b.dataset.env);
    b.classList.toggle("visited", visited.has(b.dataset.env!));
    b.classList.toggle("moving", moving !== null && moving === env?.label);
  });
  const p = state.place;
  $("place").innerHTML =
    p.where === "moving" ? `moving to <b>${esc(p.to)}</b>` : p.where === "parked" ? "parked" : `running in <b>${esc(p.host)}</b>`;
  $("tabwhere").textContent = p.where === "tab" || p.where === "home" ? "running here" : p.where === "moving" ? "handing over" : "away";
  $("usd").textContent = usd(state.cost.usd, state.cost.usd < 1 ? 3 : 2);
  $("rate").textContent = `${usd(state.cost.ratePerMin, 3)}/min`;
  const us = Object.values(state.universes);
  const live = us.filter((u) => u.status === "training" || u.status === "takeover" || u.status === "starting").length;
  $("mvsum").textContent = us.length ? `${live} live${state.scoreUnit ? `  |  score: ${state.scoreUnit}` : ""}` : "";
  $("mv").classList.toggle("dormant", us.length === 0);
  ($("killone") as HTMLButtonElement).disabled = !leader(state);
  // While the network is off the feed and the disk are unreachable by design (the take cuts the Wi-Fi): that is the story, not an error.
  $("lost").hidden = !feed.lost || (!debug && offline);
}

function renderNotes(state: ShowState, now: number): void {
  const tail = state.notes.slice(-6);
  const html = tail.map((n) => `<div class="note ${now - n.at < 6000 ? "fresh" : ""}" data-kind="${n.kind}"><time>${clock(n.at)}</time>${esc(n.text.length > 240 ? `${n.text.slice(0, 239).trimEnd()}\u2026` : n.text)}</div>`).join("");
  const el = $("notes");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

// The operator panel: one person runs the show from the page. It is hidden on camera; `o` toggles it, and while it is
// open f / k / c / h / r are shortcuts. Every button is a command to the feed; a refusal is printed, never hidden.
const operator = $("operator");
async function run(label: string, cmd: ShowCommand): Promise<void> {
  const out = $("opresult");
  out.className = "";
  out.textContent = `${label}...`;
  const r = await feed.command(cmd).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  out.textContent = r.ok ? `${label}: ok` : `${label}: ${r.message ?? "refused"}`;
  out.className = r.ok ? "" : "bad";
}
function homeEnv(state: ShowState): string {
  return state.environments.find((e) => e.id === "home")?.id ?? [...state.environments].reverse().find((e) => e.kind === "tab")?.id ?? "tab";
}
function renderOperator(state: ShowState): void {
  const box = $("openvs");
  const envs = state.environments.filter((e) => e.kind !== "gpu" && e.id !== "home" && e.id !== "universes");
  const sig = envs.map((e) => e.id).join();
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = envs.map((e) => `<button data-env="${esc(e.id)}">${esc(e.label)}</button>`).join("");
  box.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.addEventListener("click", () => void run(`switch ${b.dataset.env}`, { t: "switch", to: b.dataset.env! })));
}
const OPS: Record<string, () => void> = {
  prewarm: () => void run("prewarm", { t: "prewarm" }),
  fanout: () => void run("fan out", { t: "fanout" }),
  kill: () => {
    const l = leader(feed.state);
    if (l) void run(`kill ${l.id}`, { t: "kill", universe: l.id });
    else void run("kill", { t: "kill", universe: "" });
  },
  collapse: () => void run("collapse", { t: "collapse" }),
  home: () => void run("home", { t: "switch", to: homeEnv(feed.state) }),
  reset: () => void run("reset", { t: "reset" }),
  // Straight to the tab app, not a feed command: a push a creature shrugs off (60 N) and one that puts it on its back (400 N).
  kick60: () => bridge.send({ type: "kick", dir: [1, 0], force_n: 60 }),
  kick400: () => bridge.send({ type: "kick", dir: [1, 0], force_n: 400 }),
  ask: () => void run("ask", { t: "ask" }),
};
operator.querySelectorAll<HTMLButtonElement>("button[data-op]").forEach((b) => b.addEventListener("click", () => OPS[b.dataset.op!]()));
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.matches?.("input, textarea")) return;
  if (e.key === "o") operator.hidden = !operator.hidden;
  else if (!operator.hidden) {
    const key = { p: "prewarm", f: "fanout", k: "kill", c: "collapse", h: "home", r: "reset", a: "ask", x: "kick60", X: "kick400" }[e.key];
    if (key) OPS[key]();
    else if (e.key === "Escape") operator.hidden = true;
  }
});
if (params.get("operator") === "1") operator.hidden = false;

// The browser's own offline/online events, and the page's own proof. The take cuts the network (CDP offline emulation on this very page) and the
// creature keeps walking. The banner says "Wi-Fi off" only when the browser is offline AND this page's own attempt to reach the cloud disk (through the
// stage), timed, failed; if that attempt gets an answer the page says so and does not claim to be offline (page/offline.ts). The stage's own failed
// fetches are not an error then.
let offline = !navigator.onLine;
// Any answer short of a 5xx, even "not found", means the path to the cloud disk is up; a 502 is the stage saying it cannot reach the run's server, and a
// failure to connect is "no answer". Stopping cancels what is in flight and drops its result (page/offline.ts).
const disk = new DiskProbe((signal) => fetch("/api/disk/creature/designs.sqlite", { cache: "no-store", signal }));
const startProbing = (): void => disk.start();
const stopProbing = (): void => disk.stop();
if (offline && !debug) startProbing();
function pageNote(text: string, group?: string): void {
  addNotes({ at: feed.captionNow(), kind: "home", text, origin: "tab", rank: 2, ...(group ? { group } : {}) });
}
// The Wi-Fi control: a click is the user's act and reads off at once; after that the browser's own offline event and the page's own failed attempt are the truth.
let wifiClickedAt: number | null = null;
$("wifi").addEventListener("click", () => {
  wifiClickedAt = performance.now();
  renderWifi();
});
function renderWifi(): void {
  const b = bannerState({ offline, clickedAt: wifiClickedAt, now: performance.now(), attempts: disk.attempts });
  const el = $("wifi");
  if (el.textContent !== b.label) el.textContent = b.label;
  el.dataset.mode = b.mode;
  const line = offline ? proofLine(disk.attempts) : "";
  const proof = $("proof");
  if (proof.textContent !== line) proof.textContent = line;
  proof.hidden = line === "";
}
addEventListener("offline", () => {
  syncTake();
  offline = true;
  memory.meterOffline = [];
  memory.offlineSaid = false;
  if (!debug) startProbing();
  // Nothing said before the cut is news after it (a switch time beside "offline" read as a contradiction): the caption is about the cut. At once it says
  // what the design guarantees; a tab that reports its walk then replaces that, in place, with how far it walked offline, measured after the cut.
  if (!debug) desk.cut(feed.captionNow());
  pageNote("It keeps walking: the brain it learned runs right here.", memory.meterSeen ? "offline" : undefined);
});
addEventListener("online", () => {
  syncTake();
  offline = false;
  wifiClickedAt = null;
  stopProbing();
  pageNote("Wi-Fi back on.");
});

const desk = new CaptionDesk();
let shownV2 = "";
function renderCaptionV2(state: ShowState): void {
  const now = feed.captionNow();
  const counting = !!state.setup && state.setup.endedAt === null && !setupNoted.has(setupKey(state.setup.startedAt));
  const spoken = desk.update(withTabNotes(state), now, { yieldSlot: counting });
  // While the agent sets up the training program and nothing else is being said, the slot counts the seconds (measured on a live feed).
  const counter = !spoken && counting ? setupCaption(state, now) : null;
  const c = spoken ?? (counter ? { text: counter.text, tag: counter.tag, at: state.setup!.startedAt + Math.floor((now - state.setup!.startedAt) / 1000) * 1000 } : null);
  const key = c ? `${c.at}|${c.tag}|${c.text}` : "";
  if (key === shownV2) return;
  shownV2 = key;
  const el = $("vcaption");
  el.hidden = c === null;
  // No pill in the clean view; the tag is the caption's data, which the recorder reads (captions.json) and the published notes keep.
  const tag = c ? visibleTag(c.tag, debug) : null;
  el.dataset.tag = c?.tag ?? "";
  el.innerHTML = c ? `${tag ? `<span class="tag ${tag}">${tag}</span>` : ""}<span class="txt">${esc(c.text)}</span>` : "";
}

let shownSpark = "";
/** The small distance-per-version picture: one point per version, in the one fixed 10 s window, so learning shows where two stills of a creature cannot. */
function renderSpark(state: ShowState): void {
  const svg = sparklineSvg(chartPoints(state.versions, memory.versions));
  if (svg === shownSpark) return;
  shownSpark = svg;
  const el = $("spark");
  el.hidden = svg === "";
  el.querySelector(".svg")!.innerHTML = svg;
}

let shownDecision = "";
/** The decision card: up for a few seconds when the typed model has decided where the run goes, then gone as the badge moves. */
function renderDecision(state: ShowState): void {
  const el = $("decision");
  const d = state.decision;
  const visible = cardVisible(d, feed.captionNow()) && cardShown(d, state.source, debug);
  // A placement that is not shown is still kept: the recorder writes it to captions.json (data-record).
  el.dataset.record = d && cardVisible(d, feed.captionNow()) && !visible ? JSON.stringify({ id: d.id, phase: d.phase, choice: d.choice, latency_ms: d.latencyMs, model: d.model }) : "";
  const key = visible && d ? `${d.id}:${d.phase}` : "";
  if (key === shownDecision) return;
  shownDecision = key;
  el.hidden = !visible;
  el.classList.remove("go");
  if (!visible || !d) return void (el.innerHTML = "");
  el.dataset.tag = cardTag(d, state.source);
  el.innerHTML = decisionCardHtml(d, state.source, { pill: debug });
  // The bars grow from nothing: the width is set a frame after the card is in the page.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("go")));
}

let badgeKey = "";
function renderBadge(state: ShowState): void {
  const b = badgeFor(state);
  const el = $("badge");
  el.dataset.tone = b.tone;
  $("badge").querySelector(".txt")!.textContent = b.text;
  const memoryEl = el.querySelector<HTMLElement>(".memory")!;
  memoryEl.hidden = !b.memory;
  if (b.memory) memoryEl.textContent = MEMORY_LINE;
  const track = trackFor(state);
  el.dataset.at = track.at;
  const right = el.querySelector<HTMLElement>(".node.b")!;
  right.hidden = track.right === null;
  right.textContent = track.right ?? "";
  // The badge animates when the place changes, not on every frame.
  if (b.text !== badgeKey) {
    if (badgeKey !== "") {
      el.classList.remove("swap");
      void el.offsetWidth;
      el.classList.add("swap");
    }
    badgeKey = b.text;
  }
}

/** The creature fills the pane once the agent has left with it: the sketcher has done its job. */
let phaseSent = "";
function sendPhase(state: ShowState): void {
  if (debug || !bridge.ready) return;
  const away = state.place.where === "moving" || state.place.where === "cloud" || state.place.where === "universes";
  const phase = away ? "watch" : phaseSent === "watch" ? "watch" : "draw";
  if (phase === phaseSent) return;
  phaseSent = phase;
  bridge.send({ type: "set-phase", phase });
}

const chatLog = $("chatlog");
const chatIn = $<HTMLInputElement>("chatin");
const chatErr = $("chaterr");
$("chatform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatIn.value.trim();
  if (!text) return;
  chatErr.hidden = true;
  chatIn.disabled = true;
  const r = await feed.command({ t: "ask", text }).catch((err) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  chatIn.disabled = false;
  if (r.ok) chatIn.value = "";
  else {
    chatErr.textContent = `The agent did not take that: ${r.message ?? "refused"}`;
    chatErr.hidden = false;
  }
  chatIn.focus();
});

let shownCaption = "";
function renderCaption(state: ShowState): void {
  const list = captionsFor(withTabNotes(state), feed.captionNow());
  const el = $("caption");
  const key = list.map((c) => `${c.at}|${c.tag}|${c.text}`).join("\n");
  if (key === shownCaption) return;
  shownCaption = key;
  el.hidden = list.length === 0;
  el.innerHTML = list.map((c) => `<div class="row">${c.tag ? `<span class="tag ${c.tag}">${c.tag}</span>` : ""}<span class="txt">${esc(c.text)}</span></div>`).join("");
}

function frame(): void {
  const state = feed.state;
  const now = feed.liveNow();
  renderChrome(state);
  renderOperator(state);
  renderDecision(state);
  if (!debug) {
    addNotes(...storyNotes(state, memory.story, feed.captionNow()));
    // Only what is on screen: the badge, the chat and one caption. The old panels are not drawn at all.
    renderBadge(state);
    renderSpark(state);
    renderWifi();
    syncChat(chatLog, state.chat);
    $("chat").classList.toggle("talked", state.chat.length > 0);
    $("chat").classList.toggle("drawing", memory.drawStarted);
    renderCaptionV2(state);
    sendPhase(state);
    return;
  }
  renderCaption(state);
  desktop.update(state);
  grid.render(state, now);
  const tl = $("timeline");
  tl.innerHTML = renderTimeline(state, now, tl.clientWidth, tl.clientHeight);
  renderNotes(withTabNotes(state), now);
}

feed.onChange((event: ShowEvent | null) => {
  syncTake();
  if (event?.t === "place" || event === null) {
    sendPlacement(feed.state);
    maybeSendPolicy(feed.state);
  }
  if (event?.t === "universe" && event.patch.status === "winner") maybeSendPolicy(feed.state);
  // A feed that says when learning began (the rehearsal) ends the setup itself.
  if (!debug && event?.t === "setup" && event.phase === "end") endSetup(event.at);
});

await feed.connect().catch((e) => {
  $("lost").hidden = false;
  $("lost").textContent = `no feed: ${e instanceof Error ? e.message : String(e)}`;
});
setInterval(frame, 120);
frame();
