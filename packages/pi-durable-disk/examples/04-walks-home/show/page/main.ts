import type { HostKind, ShowCommand, ShowEvent, ShowState, TabKind, TabToShell } from "../types.ts";
import { $, clock, esc, usd } from "./dom.ts";
import { captionsFor } from "./caption.ts";
import { Feed } from "./feed.ts";
import { Grid } from "./grid.ts";
import { TabBridge } from "./shell.ts";
import { renderTimeline } from "./timeline.ts";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

const feed = new Feed();
const bridge = new TabBridge($<HTMLIFrameElement>("tab"));
const grid = new Grid($("grid"), $("strip"), (id) => void kill(id));
const visited = new Set<string>();
let lastPlacement = "";
let policySentFor = "";

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
  try {
    if (m.type === "storage-read") {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 204 || res.status === 404) return bridge.send({ type: "storage-result", id: m.id, bytes: null });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return bridge.send({ type: "storage-result", id: m.id, bytes: new Uint8Array(await res.arrayBuffer()) });
    }
    // The write is acknowledged only after the disk has it: the tab treats the ack as durability.
    const res = await fetch(url, { method: "PUT", body: m.bytes as BodyInit });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bridge.send({ type: "storage-written", id: m.id });
    tabEvent(`disk write ${m.path} ${m.bytes.byteLength} B`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (m.type === "storage-read") bridge.send({ type: "storage-result", id: m.id, bytes: null, error: message });
    else bridge.send({ type: "storage-written", id: m.id, error: message });
  }
}

bridge.onMessage((m: TabToShell) => {
  if (m.type === "storage-read" || m.type === "storage-write") return void answerStorage(m);
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
  sendPlacement(feed.state);
  maybeSendPolicy(feed.state);
});

/** The winner's policy goes to the tab once, when the run is home. D2 writes it as work/home/policy.json (mlp-v1 JSON); the stage serves it at /policy/home.json from POLICY_DIR. */
function maybeSendPolicy(state: ShowState): void {
  if (state.place.where !== "home" || !bridge.ready) return;
  const winner = Object.values(state.universes).find((u) => u.status === "winner");
  if (!winner || policySentFor === winner.id) return;
  policySentFor = winner.id;
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
  $("lost").hidden = !feed.lost;
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
  fanout: () => void run("fan out", { t: "fanout" }),
  kill: () => {
    const l = leader(feed.state);
    if (l) void run(`kill ${l.id}`, { t: "kill", universe: l.id });
    else void run("kill", { t: "kill", universe: "" });
  },
  collapse: () => void run("collapse", { t: "collapse" }),
  home: () => void run("home", { t: "switch", to: homeEnv(feed.state) }),
  reset: () => void run("reset", { t: "reset" }),
  ask: () => void run("ask", { t: "ask" }),
};
operator.querySelectorAll<HTMLButtonElement>("button[data-op]").forEach((b) => b.addEventListener("click", () => OPS[b.dataset.op!]()));
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.matches?.("input, textarea")) return;
  if (e.key === "o") operator.hidden = !operator.hidden;
  else if (!operator.hidden) {
    const key = { f: "fanout", k: "kill", c: "collapse", h: "home", r: "reset", a: "ask" }[e.key];
    if (key) OPS[key]();
    else if (e.key === "Escape") operator.hidden = true;
  }
});
if (params.get("operator") === "1") operator.hidden = false;

let shownCaption = "";
function renderCaption(state: ShowState): void {
  const list = captionsFor(state, feed.captionNow());
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
  renderCaption(state);
  grid.render(state, now);
  const tl = $("timeline");
  tl.innerHTML = renderTimeline(state, now, tl.clientWidth, tl.clientHeight);
  renderNotes(state, now);
}

feed.onChange((event: ShowEvent | null) => {
  if (event?.t === "place" || event === null) {
    sendPlacement(feed.state);
    maybeSendPolicy(feed.state);
  }
  if (event?.t === "universe" && event.patch.status === "winner") maybeSendPolicy(feed.state);
});

await feed.connect().catch((e) => {
  $("lost").hidden = false;
  $("lost").textContent = `no feed: ${e instanceof Error ? e.message : String(e)}`;
});
setInterval(frame, 120);
frame();
