import type { ShowEvent, ShowState, TabKind, TabToShell } from "../types.ts";
import { $, clock, esc, usd } from "./dom.ts";
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

const TAB_KIND: Record<string, TabKind> = { tab: "tab", home: "tab", sandbox: "daytona", vm: "vm", gpu: "gpu" };

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
$("kick").addEventListener("click", () => bridge.send({ type: "kick", dir: [1, 0, 0.2], force_n: 60 }));
$("memory").addEventListener("click", () => bridge.send({ type: "open-memory" }));

let tabLine: string[] = [];
function tabEvent(text: string): void {
  tabLine = [...tabLine.slice(-2), text];
  $("tabevents").textContent = tabLine.join("  |  ");
}

bridge.onMessage((m: TabToShell) => {
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
  bridge.send({ type: "set-placement", kind: TAB_KIND[env] ?? "tab", label: "host" in state.place && state.place.host ? state.place.host : label, since: Date.now() });
}

bridge.onReady(() => {
  lastPlacement = "";
  sendPlacement(feed.state);
  maybeSendPolicy(feed.state);
});

/** The winner's policy goes to the tab once, when the run is home: a same-origin path, the format is D2's and D3's. */
function maybeSendPolicy(state: ShowState): void {
  if (state.place.where !== "home" || !bridge.ready) return;
  const winner = Object.values(state.universes).find((u) => u.status === "winner");
  if (!winner || policySentFor === winner.id) return;
  policySentFor = winner.id;
  bridge.send({ type: "load-policy", url: `/policy/${encodeURIComponent(winner.id)}.bin` });
}

function renderChrome(state: ShowState): void {
  $("run").textContent = state.run;
  const sw = $("switcher");
  const sig = state.environments.map((e) => e.id).join();
  if (sw.dataset.sig !== sig) {
    sw.dataset.sig = sig;
    sw.innerHTML = state.environments.map((e) => `<button data-env="${esc(e.id)}" data-kind="${esc(e.kind)}"><span class="dot"></span>${esc(e.label)}</button>`).join("");
    sw.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await feed.command({ t: "switch", to: b.dataset.env! });
        if (!r.ok) tabEvent(`switch refused: ${r.message ?? "?"}`);
      }),
    );
  }
  if (state.currentEnv) visited.add(state.currentEnv);
  const moving = state.place.where === "moving" ? state.place.to : null;
  sw.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
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
  $("mvsum").textContent = us.length ? `${live} live` : "";
  ($("killone") as HTMLButtonElement).disabled = !leader(state);
  $("lost").hidden = !feed.lost;
}

function renderNotes(state: ShowState, now: number): void {
  const tail = state.notes.slice(-6);
  const html = tail.map((n) => `<div class="note ${now - n.at < 6000 ? "fresh" : ""}" data-kind="${n.kind}"><time>${clock(n.at)}</time>${esc(n.text)}</div>`).join("");
  const el = $("notes");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function frame(): void {
  const state = feed.state;
  const now = feed.liveNow();
  renderChrome(state);
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
