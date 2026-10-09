// A feed made from a 03 pipe: the stage connects to the run's pipe as a client and turns what the pipe says into
// ShowEvents, so the switcher beat (tab -> a host -> back) shows the real placements, the real notice the agent was
// told, the agent's own answers, and the time the SERVER measured for the switch. Invariants:
//   - The only measured number it emits is `switched.ms`, which the pipe computes from its own clock (it received the
//     switch frame; the new host reported the notice committed and the run resumed). Everything else is unflagged.
//   - It never invents a placement: a settled stay begins only when the pipe says the run is there (and, for a planned
//     switch, when the pipe reports the switch done, so the stay carries the measured handover).
//   - The translator is pure (frames in, events out); the sockets live in PipeFeed.
// TODO(browser-demo): the pipe lets any client, a view one included, send `switch` and `submit`. This client says which
// role it connects as through `role`; when the pipe adds an operator role with a check, set SHOW_PIPE_ROLE=operator and
// view stays read-only.
import { ChatView } from "../../03-tab-to-cloud/tab/chat-view.ts";
import { untag, type PipeFrame, type Tagged } from "../../03-tab-to-cloud/wire.ts";
import { emptyState, reduce } from "./reduce.ts";
import type { TabControl } from "./tab-control.ts";
import type { HostKind, Note, ShowCommand, ShowEvent, ShowState } from "./types.ts";

type PipeEnv = { id: string; label: string; phrase: string; kind: "tab" | "cloud" | "remote"; detail?: string };
type Placement = Extract<PipeFrame, { t: "placement" }>["placement"];
type Viewing = Extract<PipeFrame, { t: "viewing" }>;

/** What a question to the agent after a switch reads like; short on purpose, it costs model tokens. */
export const WHERE_ARE_YOU = "Which machine are you on right now? Check with bash (uname -a, nproc, and nvidia-smi if it exists) and answer in two short lines.";

export function kindOf(env: PipeEnv): HostKind {
  if (env.kind === "tab") return "tab";
  const name = `${env.id} ${env.label}`;
  return /gpu/i.test(name) ? "gpu" : /\bvm\b/i.test(name) ? "vm" : "sandbox";
}

type Pending = { switchId: string; toEnv: string; toLabel: string; fromHost: string; fromEnv: string | null; at: number };
type Settled = { env: string; host: string; place: ShowState["place"] };

export class PipeTranslator {
  readonly chat = new ChatView();
  private envs = new Map<string, PipeEnv>();
  private origin: number;
  private clock: () => number;
  private started = false;
  private currentStay: string | undefined;
  private currentHost = "";
  private currentEnv: string | null = null;
  private pending: Pending | undefined;
  /** A settled placement waiting for the pipe's `switched` frame, which carries the measured time. */
  private waiting: { settled: Settled; at: number } | undefined;
  /** A `switched` frame that arrived before its settled placement. */
  private done: { switchId: string; ms: number } | undefined;
  private stays = 0;
  private seenItems = new Set<string>();
  private answeredUsers = new Set<string>();
  private run = "";

  constructor(options: { run: string; origin?: number; clock?: () => number }) {
    this.run = options.run;
    this.clock = options.clock ?? Date.now;
    this.origin = options.origin ?? this.clock();
  }

  private at(): number {
    return Math.max(0, this.clock() - this.origin);
  }

  environments(): ShowState["environments"] {
    return [...this.envs.values()].map((e) => ({ id: e.id, label: e.label, kind: kindOf(e) }));
  }

  envLabel(id: string): string {
    return this.envs.get(id)?.label ?? id;
  }

  kindOfEnv(id: string): HostKind | undefined {
    const e = this.envs.get(id);
    return e ? kindOf(e) : undefined;
  }

  hasEnv(id: string): boolean {
    return this.envs.has(id);
  }

  /** The env the run is settled in, or null while it moves or is parked. */
  get where(): string | null {
    return this.currentEnv;
  }

  frame(frame: PipeFrame): ShowEvent[] {
    const out: ShowEvent[] = [];
    switch (frame.t) {
      case "viewing":
        this.viewing(frame, out);
        break;
      case "placement":
        if (this.started) this.placement(frame.placement, out);
        break;
      case "switched":
        this.switched(frame, out);
        break;
      case "switch-refused":
        out.push({ t: "note", at: this.at(), kind: "switch", text: `Switch to ${this.envLabel(frame.to)} refused: ${frame.message}.` });
        break;
      case "event":
        if (this.started) this.events(frame.event, out);
        break;
      case "lost":
      case "error": {
        const message = frame.t === "lost" ? `${frame.code}: ${frame.message}` : frame.message;
        out.push({ t: "note", at: this.at(), kind: "story", text: `The pipe said: ${message}` });
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** Called on a timer: a settled placement that never got its `switched` frame begins its stay without a time. */
  flush(maxWaitMs = 15_000): ShowEvent[] {
    const out: ShowEvent[] = [];
    if (this.waiting && this.clock() - this.waiting.at >= maxWaitMs) {
      this.beginStay(this.waiting.settled, undefined, out);
      this.waiting = undefined;
      this.pending = undefined;
    }
    return out;
  }

  private viewing(frame: Viewing, out: ShowEvent[]): void {
    this.envs = new Map((frame.environments as PipeEnv[]).map((e) => [e.id, e]));
    if (!this.started) {
      this.started = true;
      out.push({ t: "run", at: 0, run: this.run, origin: this.origin, environments: this.environments(), source: "live" });
    }
    this.placement(frame.placement, out, true);
    // The transcript so far is history: remember it, announce none of it.
    for (const e of frame.events) this.fold(e);
    for (const item of this.chat.items()) {
      this.seenItems.add(item.id);
      if (item.kind === "user") this.answeredUsers.add(item.id);
    }
  }

  private envOf(p: Placement): string | null {
    return p.where === "tab" || p.where === "cloud" || p.where === "moving" ? p.env : null;
  }

  private placement(p: Placement, out: ShowEvent[], initial = false): void {
    const at = this.at();
    if (p.where === "moving") {
      this.pending = { switchId: p.switchId ?? "", toEnv: p.env, toLabel: p.to, fromHost: this.currentHost, fromEnv: this.currentEnv, at };
      this.currentEnv = null;
      this.waiting = undefined;
      out.push({ t: "place", at, place: { where: "moving", to: p.to, host: this.currentHost }, env: null });
      if (p.detail) out.push({ t: "note", at, kind: "story", text: `Moving to ${p.to}: ${p.detail}.` });
      return;
    }
    if (p.where === "parked") {
      if (this.currentStay) out.push({ t: "stay.end", at, id: this.currentStay, endedBy: "switch" });
      this.currentStay = undefined;
      this.currentEnv = null;
      this.pending = undefined;
      this.waiting = undefined;
      out.push({ t: "place", at, place: { where: "parked" }, env: null });
      if (p.detail) out.push({ t: "note", at, kind: "story", text: `The run is parked: ${p.detail}.` });
      return;
    }
    const env = this.envOf(p)!;
    const e = this.envs.get(env);
    const host = p.where === "cloud" ? p.host : (e?.label ?? env);
    const where = e ? (e.kind === "tab" ? "tab" : "cloud") : p.where === "tab" ? "tab" : "cloud";
    const settled: Settled = { env, host, place: { where, host } };
    this.currentEnv = env;
    out.push({ t: "place", at, place: settled.place, env });
    if (this.pending && !initial) {
      if (this.done && this.done.switchId === this.pending.switchId) {
        // The pipe reported the switch done before this placement frame arrived: the time is already known.
        this.beginStay(settled, { fromHost: this.pending.fromHost, ms: this.done.ms, planned: true }, out);
        this.pending = undefined;
        this.done = undefined;
      } else {
        // A planned switch: the stay begins when the pipe reports it done, so it carries the measured handover.
        this.waiting = { settled, at: this.clock() };
      }
    } else {
      this.beginStay(settled, undefined, out);
    }
    this.currentHost = host;
  }

  private beginStay(s: Settled, handover: { fromHost: string; ms: number; planned: boolean } | undefined, out: ShowEvent[]): void {
    const at = this.at();
    if (this.currentStay) out.push({ t: "stay.end", at, id: this.currentStay, endedBy: "switch" });
    const id = `p${++this.stays}`;
    this.currentStay = id;
    const hostKind = kindOf(this.envs.get(s.env) ?? { id: s.env, label: s.host, phrase: s.host, kind: "cloud" });
    out.push({ t: "stay.begin", at, stay: { id, lane: "run", host: s.host, hostKind, from: at, ...(handover ? { handover } : {}) } });
  }

  private switched(frame: Extract<PipeFrame, { t: "switched" }>, out: ShowEvent[]): void {
    const at = this.at();
    const label = this.envLabel(frame.to);
    const pending = this.pending;
    if (this.waiting && pending && pending.switchId === frame.switchId) {
      this.beginStay(this.waiting.settled, { fromHost: pending.fromHost, ms: Math.round(frame.ms), planned: true }, out);
      this.waiting = undefined;
    }
    if (pending?.switchId === frame.switchId) {
      if (this.currentEnv === null) this.done = { switchId: frame.switchId, ms: Math.round(frame.ms) };
      else this.pending = undefined;
    }
    // The one measured number: the pipe's own clock, from the switch frame to the notice committed and the run resumed.
    out.push({ t: "note", at, kind: "switch", measured: true, text: `Switched to ${label} in ${Math.round(frame.ms)} ms (timed by the server).` });
  }

  private fold(tagged: Tagged): void {
    const event = untag(tagged) as { kind?: string; event?: unknown; events?: unknown[] };
    if (event.kind === "snapshot") this.chat.apply(event.event as never);
    else if (event.kind === "events") for (const e of event.events ?? []) this.chat.apply(e as never);
  }

  private events(tagged: Tagged, out: ShowEvent[]): void {
    this.fold(tagged);
    const at = this.at();
    const items = this.chat.items();
    for (const item of items) {
      if (item.kind === "switch" && !this.seenItems.has(item.id)) {
        this.seenItems.add(item.id);
        out.push({ t: "note", at, kind: "agent", text: `The agent was told: ${item.text.replace(/^System notice:\s*/i, "")}` });
      }
    }
    // An answer is announced once, when the run is idle and the last assistant message after a user message is final.
    if (!this.chat.busy) {
      let user: string | undefined;
      let answer: { id: string; text: string } | undefined;
      for (const item of items) {
        if (item.kind === "user") {
          user = item.id;
          answer = undefined;
        } else if (item.kind === "assistant" && !item.streaming && item.text.trim()) answer = { id: item.id, text: item.text.trim() };
      }
      if (user && answer && !this.answeredUsers.has(user)) {
        this.answeredUsers.add(user);
        out.push({ t: "note", at, kind: "agent", text: `The agent says: ${answer.text.replace(/\s+/g, " ")}` });
      }
    }
  }
}

/** Anything the server's feed slot can be: the scripted player, or a pipe. */
export interface FeedSource {
  readonly state: ShowState;
  readonly events: ShowEvent[];
  subscribe(listener: (event: ShowEvent) => void): () => void;
  command(cmd: ShowCommand): { ok: boolean; message?: string } | Promise<{ ok: boolean; message?: string }>;
  stop(): void;
}

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open" | "close" | "error", fn: () => void): void;
  on(event: "message", fn: (data: unknown) => void): void;
};

export type PipeFeedOptions = {
  /** ws://host:port/ws of the 03 server and the run to watch; `token` is the run's secret. */
  url: string;
  run: string;
  token: string;
  /** The hello mode. "view" today; "operator" once the pipe has the role check (see the TODO above). */
  role?: string;
  /** Ask the agent where it is after each completed switch (a few model tokens). Default true. */
  askAfterSwitch?: boolean;
  /** Rehearsal only (tab-control.ts): who asks for the switch back to the tab, because a view client cannot take the run. */
  tabControl?: TabControl;
  connect?: (url: string) => SocketLike;
  /** Log every frame's type (not its contents). */
  trace?: boolean;
  clock?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

export class PipeFeed implements FeedSource {
  readonly events: ShowEvent[] = [];
  private st: ShowState = emptyState();
  private listeners = new Set<(event: ShowEvent) => void>();
  private tr: PipeTranslator;
  private socket: SocketLike | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refusal: ((message: string) => void) | undefined;
  private asked = 0;
  private opts: PipeFeedOptions;

  constructor(options: PipeFeedOptions) {
    this.opts = options;
    this.tr = new PipeTranslator({ run: options.run, ...(options.clock ? { clock: options.clock } : {}) });
  }

  get state(): ShowState {
    return this.st;
  }

  subscribe(listener: (event: ShowEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(list: ShowEvent[]): void {
    for (const event of list) {
      this.events.push(event);
      this.st = reduce(this.st, event);
      for (const l of this.listeners) l(event);
    }
  }

  async start(): Promise<void> {
    const connect = this.opts.connect ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => never }).WebSocket(url) as SocketLike);
    const open = () => {
      const socket = connect(this.opts.url);
      this.socket = socket;
      socket.on("open", () => socket.send(JSON.stringify({ t: "hello", run: this.opts.run, token: this.opts.token, mode: this.opts.role ?? "view", tab: `stage-${process.pid}` })));
      socket.on("message", (data) => this.onMessage(String(data)));
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.opts.log?.("pipe.closed");
        if (!this.stopped) setTimeout(open, 2_000).unref?.();
      });
    };
    open();
    this.timer = setInterval(() => this.emit(this.tr.flush()), 1_000);
    this.timer.unref?.();
  }

  private onMessage(text: string): void {
    let frame: PipeFrame;
    try {
      frame = JSON.parse(text) as PipeFrame;
    } catch {
      return;
    }
    // SHOW_PIPE_TRACE=1: which frames the pipe sent this viewer, by type, for finding what a viewer is not told.
    if (this.opts.trace && frame.t !== "pong" && frame.t !== "files-changed") this.opts.log?.("frame", { t: frame.t, ...(frame.t === "placement" ? { where: frame.placement.where, env: "env" in frame.placement ? frame.placement.env : undefined } : {}), ...(frame.t === "switched" ? { to: frame.to, ms: frame.ms } : {}) });
    if (frame.t === "switch-refused") this.refusal?.(frame.message);
    this.emit(this.tr.frame(frame));
    if (frame.t === "switched" && this.opts.askAfterSwitch !== false) setTimeout(() => this.ask(WHERE_ARE_YOU), 400);
  }

  private ask(text: string): { ok: boolean; message?: string } {
    if (!this.socket || this.socket.readyState !== 1) return { ok: false, message: "the pipe is not connected" };
    if (this.tr.where === null) return { ok: false, message: "the run is not settled on a host" };
    this.socket.send(JSON.stringify({ t: "submit", text, requestId: `stage-${Date.now().toString(36)}-${++this.asked}` }));
    return { ok: true };
  }

  async command(cmd: ShowCommand): Promise<{ ok: boolean; message?: string }> {
    if (cmd.t === "ask") return this.ask(cmd.text ?? WHERE_ARE_YOU);
    if (cmd.t !== "switch") return { ok: false, message: "this feed has one run and no universes" };
    if (!this.socket || this.socket.readyState !== 1) return { ok: false, message: "the pipe is not connected" };
    if (!this.tr.hasEnv(cmd.to)) return { ok: false, message: `no environment ${cmd.to}` };
    if (this.tr.where === cmd.to) return { ok: false, message: "the run is already there" };
    if (this.opts.tabControl && this.tr.kindOfEnv(cmd.to) === "tab") return this.opts.tabControl.switchToTab();
    // The pipe answers a refused switch with a frame; wait briefly for it so the caller hears the reason.
    const refused = new Promise<string | undefined>((resolve) => {
      this.refusal = (message) => resolve(message);
      setTimeout(() => resolve(undefined), 700);
    });
    this.socket.send(JSON.stringify({ t: "switch", to: cmd.to }));
    const message = await refused;
    this.refusal = undefined;
    return message === undefined ? { ok: true } : { ok: false, message };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
  }
}

export type { Note };
