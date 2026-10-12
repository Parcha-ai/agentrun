// What the stage says about the tab's own events (robot-events.ts). Pure: state in, words or HTML out. Everything said is a field of an event; a number the event did not carry is not said.
import { esc } from "./page/dom.ts";
import type { Checkin, Homecoming, Net, Note, Routing, Stumble, ToolRow } from "./types.ts";

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

/** The body changed and some installed skills no longer fit it: said once, with only what the tab's event carried (the skills, not a duration or a GPU count). */
export function stumbleNote(s: Stumble, at: number): Note {
  const n = s.notFitting.length;
  return { at, kind: "home", text: `The robot's body changed: ${n} ${n === 1 ? "skill" : "skills"} no longer fit it, so it stumbles`, rank: 5, urgent: true, keep: true };
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

/** One change a tool call made to a file: the file and, in a few words, what changed. */
export type FileChange = { path: string; what: string };

const WHAT_MAX = 80;
const scalar = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null);

function contentSummary(content: string): string {
  if (content === "") return "written";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pairs = Object.entries(parsed as Record<string, unknown>).flatMap(([k, v]) => (scalar(v) === null ? [] : [`${k}: ${scalar(v)}`]));
      if (pairs.length > 0) return clip(pairs.join(", "), WHAT_MAX);
    }
  } catch {
    // not JSON: its first line
  }
  return clip(content.split("\n")[0]!.trim() || "written", WHAT_MAX);
}

/** The robot's own tools (03-tab-to-cloud/robot-tools.ts): the demo changes the robot with these, not by writing files. */
const ROBOT_TOOLS = new Set(["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do", "update_robot"]);

/** The tail sentences a robot tool result ends with (what the change means for the walking brain), and the sentences that say nothing happened: neither is the change. */
const NOT_THE_CHANGE = /^(Not done|No change|Looks only|This changes the body|The body is unchanged|The body has been changed since)\b/;

/**
 * What a finished robot tool call did, in the result's own sentences (the tool says what actually happened: a part it refused, a size the limits cut short, a call that changed nothing): the
 * sentences of the result that are not a refusal, a no-op or the note about the walking brain. Null when none is left (nothing changed) or the call gave no result.
 */
function robotToolWhat(t: ToolRow): string | null {
  const sentences = t.output.trim().split(/(?<=[.!?])\s+/).filter((x) => x !== "" && !NOT_THE_CHANGE.test(x));
  return sentences.length > 0 ? clip(sentences.join(" "), WHAT_MAX) : null;
}

/**
 * What the finished write and edit calls changed, read from the calls' own arguments: an edit is "old -> new" (or each of its edits), a write of a JSON object lists its top-level values, any
 * other write its first line. A running or failed call changed nothing yet; reads, shell commands and the like are not file changes here (the tool strip shows them).
 */
export function fileChanges(tools: readonly ToolRow[]): FileChange[] {
  const out: FileChange[] = [];
  for (const t of tools) {
    if (t.status !== "done") continue;
    if (ROBOT_TOOLS.has(t.name)) {
      const what = robotToolWhat(t);
      if (what !== null) out.push({ path: "robot", what });
      continue;
    }
    if (t.name !== "write" && t.name !== "edit") continue;
    let a: Record<string, unknown>;
    try {
      const parsed = JSON.parse(t.args) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      a = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof a.path !== "string" || a.path === "") continue;
    if (t.name === "write") out.push({ path: a.path, what: contentSummary(typeof a.content === "string" ? a.content : "") });
    else {
      const edits = Array.isArray(a.edits) ? a.edits : [a];
      const parts = edits.flatMap((e) => (e !== null && typeof e === "object" && typeof (e as Record<string, unknown>).oldText === "string" && typeof (e as Record<string, unknown>).newText === "string" ? [`${(e as Record<string, string>).oldText} -> ${(e as Record<string, string>).newText}`] : []));
      if (parts.length > 0) out.push({ path: a.path, what: clip(parts.join("; "), WHAT_MAX) });
    }
  }
  return out;
}

/** The robot-change card: who changed the robot (the brain the latest decision named, else the agent), whether the tab was offline, and each file with what changed (the newest few). */
export function changeCardHtml(changes: readonly FileChange[], net: Net | null, routing: Routing | null): string {
  if (changes.length === 0) return "";
  const who = routing ? (routing.answering ?? (routing.brain === "tab-local" ? "the model in this tab" : "the cloud model")) : "the agent";
  const items = changes.slice(-5).map((c) => `<li><b>${esc(c.path)}</b> ${esc(c.what)}</li>`).join("");
  return `<div class="cc"><div class="k">The robot was changed by</div><div class="who">${esc(who)}${net !== null && !net.online ? ' <span class="off">offline</span>' : ""}</div><ul>${items}</ul></div>`;
}
