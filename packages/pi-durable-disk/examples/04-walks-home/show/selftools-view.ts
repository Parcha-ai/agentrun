// What the stage says about the tab's own events (selftools.ts). Pure: state in, words or HTML out. Everything said is a field of an event; a number the event did not carry is not said.
import { esc } from "./page/dom.ts";
import type { Checkin, Homecoming, Net, Note, Routing, ToolRow } from "./types.ts";

const bytes = (n: number): string => (n === 0 ? "0 bytes" : n < 1e6 ? `${Math.round(n / 1e3)} KB` : n < 1e8 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e6)} MB`);
const duration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 1e4 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** ONLINE or OFFLINE from the tab's own signal (navigator.onLine plus a failed ping, as the tab decided), with its reason as the hover text. Null until the tab has said. */
export function netBadge(net: Net | null): { label: "ONLINE" | "OFFLINE"; online: boolean; title: string } | null {
  return net === null ? null : { label: net.online ? "ONLINE" : "OFFLINE", online: net.online, title: net.reason ?? "" };
}

/** The decision card: who a message went to, why, and how it was decided (Jev's probability and the time it took, or a rule). */
export function routingCardHtml(r: Routing): string {
  const who = r.answering ?? (r.brain === "tab-local" ? "the model in this tab" : "the cloud model");
  const how =
    r.decidedBy === "jev"
      ? ["decided by Jev", r.confidence !== null ? `${Math.round(r.confidence * 100)}% sure` : null, r.ms !== null ? `in ${Math.round(r.ms)} ms` : null].filter((p) => p !== null).join(", ")
      : r.decidedBy === "rule"
        ? "decided by a rule"
        : "";
  return `<div class="rc" data-brain="${r.brain}"><div class="k">Last message went to</div><div class="who">${esc(who)}</div><div class="why">Why: ${esc(r.reason)}</div>${how ? `<div class="how">${esc(how)}</div>` : ""}</div>`;
}

/** The check-in's line: the phase, and the numbers the event carried. */
export function checkinLine(c: Checkin | null): string | null {
  if (c === null) return null;
  if (c.phase === "start") return c.resumed ? "Checking in again: the earlier attempt was cut off, so the saved copy is sent as it was" : "Checking in: sending this browser's copy of the run to the server";
  if (c.phase === "failed") return `The check-in did not go through${c.message ? `: ${c.message}` : ""}. This browser keeps its copy`;
  const parts = [c.files !== null ? `${plural(c.files, "file", "files")} written offline came home` : null, c.changes !== null ? plural(c.changes, "change", "changes") : null].filter((p) => p !== null);
  if (parts.length === 0) return c.ms !== null ? `Checked in (${duration(c.ms)})` : "Checked in";
  return `Checked in: ${parts.join(", ")}${c.ms !== null ? `, in ${duration(c.ms)}` : ""}`;
}

/** The homecoming's bytes: what the page fetched, and "base 0 bytes" only when the plan said the base was already in this browser. */
export function homecomingLine(h: Homecoming | null): string | null {
  if (h === null) return null;
  const wire = h.fetchedBytes !== null ? `${bytes(h.fetchedBytes)} on the wire${h.fetchMs !== null ? ` in ${duration(h.fetchMs)}` : ""}` : null;
  if (h.prefetch) return `The base model came home while the agent trained${wire ? `: ${wire.replace(" on the wire", "")}` : ""}`;
  const load = h.loadMs !== null ? `. Loaded in ${duration(h.loadMs)}` : "";
  if (h.baseFetched) return `Came home${wire ? `: ${wire}, the whole model` : ""}${load}`;
  return `Came home${wire ? `: ${wire}` : ""}. The base model was already in this browser: base 0 bytes${load}`;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** A tool call as one short phrase: its name and the argument that says what it did (a path or a command). Arguments the stage cannot read leave the name alone. */
export function toolSummary(t: ToolRow): string {
  let arg: string | null = null;
  try {
    const a = JSON.parse(t.args) as unknown;
    if (a !== null && typeof a === "object") {
      const o = a as Record<string, unknown>;
      arg = typeof o.path === "string" && o.path ? o.path : typeof o.command === "string" && o.command ? o.command.replace(/\s+/g, " ") : null;
    }
  } catch {
    arg = null;
  }
  return clip(arg === null ? t.name : `${t.name} ${arg}`, 64);
}

const GLYPH: Record<ToolRow["status"], string> = { running: "…", done: "✓", error: "✗", interrupted: "!" };
const SHOWN_ROWS = 6;

/** The tool calls of the current task: a row per call, in order, the newest few when there are many. */
export function toolStripHtml(tools: readonly ToolRow[]): string {
  if (tools.length === 0) return "";
  const shown = tools.slice(-SHOWN_ROWS);
  const hidden = tools.length - shown.length;
  const rows = shown.map((t) => `<div class="tr" data-status="${t.status}"><span class="st">${GLYPH[t.status]}</span><span class="cmd">${esc(toolSummary(t))}</span>${t.output ? `<span class="out">${esc(clip(t.output.split("\n")[0]!.trim(), 80))}</span>` : ""}</div>`);
  return `<div class="ts">${hidden > 0 ? `<div class="more">${hidden} earlier ${hidden === 1 ? "call" : "calls"}</div>` : ""}${rows.join("")}</div>`;
}

/** The caption for a net change: said, and kept, because the stage's whole point at that beat is that the agent went offline and is still working. */
export function netNote(net: Net, at: number): Note {
  return { at, kind: "home", text: net.online ? "The agent's tab is back online" : `The agent's tab is offline${net.reason ? `: ${net.reason}` : ""}`, rank: 5, urgent: true, keep: true };
}

/** A check-in that finished or failed is said; one that is only starting is the line's to say. */
export function checkinNote(c: Checkin, at: number): Note | null {
  const text = c.phase === "start" ? null : checkinLine(c);
  return text === null ? null : { at, kind: "home", text, rank: c.phase === "failed" ? 5 : 4, urgent: true };
}

/** The bytes a homecoming put on the wire, as a caption: measured only when the feed is live and the event carried the bytes. */
export function homecomingNote(h: Homecoming, at: number, live: boolean): Note | null {
  const text = homecomingLine(h);
  // A scripted feed never claims a measurement, whatever its events carry.
  return text === null ? null : { at, kind: "home", text, rank: 3, ...(live && h.fetchedBytes !== null ? { measured: true } : {}) };
}
