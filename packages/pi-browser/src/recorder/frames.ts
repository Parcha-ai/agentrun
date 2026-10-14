import { createHash } from "node:crypto";
import type { BrowserProvider } from "../core/host.js";
import type { LeaseRef } from "../core/lease.js";
import { CREDENTIAL_PROBE } from "./credential.js";
import { followPage, type Follower } from "./follow.js";
import { jpegSize } from "./jpeg.js";

export type FrameData = { session: string; provider: string; w: number; h: number; mime: "image/jpeg" };
/** `detail`, when present, says why a `credential_on_page` gap was written: `field` (a credential or code field holds a value), `typed` (one held a value
 *  since the last check), `too_deep` (the page nests deeper than the check reads), `unreadable_frame` (a visible frame whose content cannot be read), `host` (the host paused
 *  the session). Anything the check cannot read counts as a credential being present. */
export type FrameGapData = { session: string; from: number; reason: "process_killed" | "credential_on_page" | "session_released"; detail?: string };

/** One live line of agentrun.recording/1. `seq`, the line's place among the process's live lines, is the writer's to add. */
export type FrameLine =
  | { channel: "live"; source: "browser"; kind: "frame"; t: number; gen?: number; conv: number; data: FrameData; blobs: [string] }
  | { channel: "live"; source: "browser"; kind: "frame.gap"; t: number; gen?: number; conv: number; data: FrameGapData };

/** `blobs` maps each sha256 a line names to its bytes; the sink keeps them as `blobs/<sha256>.jpg`. A sink that throws or rejects is
 *  ignored: a recorder never fails a browser call. */
export type FrameSink = (line: FrameLine, blobs?: Record<string, Uint8Array>) => void | Promise<void>;

export type FrameRecorderOptions = {
  sink: FrameSink;
  /** Milliseconds since the recording started: `t` of every line, and the `from` of a gap, are read from it. */
  clock: () => number;
  /** This process's generation, set on every line when given. */
  gen?: () => number;
  /** When a session this process did not create is taken up, the `t` of that session's last frame in an earlier process (the host reads
   *  it from the recording), so a `process_killed` gap can start where the frames stopped; null: it has none. Absent: no such gap. */
  lastFrameAt?: (session: string) => number | null;
  maxFps?: number;
  maxWidth?: number;
  quality?: number;
  /** How long one line may wait for the sink before it counts as dropped; default 5 s. */
  sinkTimeoutMs?: number;
  /** The clock and the waits the page checks are paced by (default: performance.now and timers). A test passes a virtual one. */
  probeClock?: ProbeClock;
  /** Called with the probe clock's time as each check of the page is sent. */
  onProbe?: (at: number) => void;
};
export type ProbeClock = { now(): number; sleep(ms: number): Promise<void> };

export type FrameRecorder = {
  /** The provider, with every session it creates or is reattached to captured, and every release ending that capture with a gap. Its
   *  own methods are untouched. `conv` is the pi conversation that owns the sessions; without it, it is read from the lease tag
   *  (`ar-<run>-<conversation>-<n>`), and a session whose conversation cannot be told is not recorded. */
  watch(provider: BrowserProvider, conv?: number): BrowserProvider;
  /** Pauses a session's capture as if a credential were on its page (a code entered, a setup key shown). It lifts at the next
   *  navigation of the page, or at `resume`. */
  pause(session: string): void;
  resume(session: string): void;
  stats(): { frames: number; gaps: number; dropped: number; sessions: number };
  close(): Promise<void>;
};

const MAX_QUEUED_LINES = 32;
/** The conversation id in a lease tag: `ar-<run>-<conversation>-<n>`. */
const tagConversation = (tag: string): number | null => { const m = /-(\d+)-\d+$/.exec(tag); return m ? Number(m[1]) : null; };

type Verdict = { hold: boolean; why: string | null } | "unchecked";
type Held = { bytes: Buffer; page: { deviceWidth: number; deviceHeight: number; epoch: number }; verdict?: Verdict };
/** One session asks its page at most 1000 / PROBE_GAP_MS = 20 times a second: arrival checks and delivery checks share one pace, each sent at least this far after the last. */
const PROBE_GAP_MS = 50;

type Capture = {
  ref: LeaseRef; conv: number; provider: string;
  follower: Follower | null;
  lastFrameT: number | null;
  paused: boolean;
  navigated: boolean;
  /** The newest frame that has been judged against the page at its capture, waiting for its turn to be kept. */
  ready: Held | null;
  /** The newest frame that has not: it waits for the check that is running. */
  waiting: Held | null;
  probing: boolean;
  /** The next moment (performance.now) a check of the page may start; every check takes the slot at this time. */
  lastProbeAt: number;
  /** The checks of the page wait here for their turns. */
  pacing: Promise<void>;
  busy: boolean;
  timer: NodeJS.Timeout | null;
  lastEmitMs: number;
  stopped: boolean;
  reconnect: NodeJS.Timeout | null;
};

export function frameRecorder(options: FrameRecorderOptions): FrameRecorder {
  const maxFps = Math.max(1, Math.min(10, options.maxFps ?? 10));
  const maxWidth = Math.min(800, options.maxWidth ?? 800);
  const quality = options.quality ?? 60;
  const spacingMs = Math.ceil(1000 / maxFps);
  const captures = new Map<string, Capture>();
  const made = new Set<string>();
  const counts = { frames: 0, gaps: 0, dropped: 0 };
  const sinkTimeoutMs = options.sinkTimeoutMs ?? 5_000;
  const pclock: ProbeClock = options.probeClock ?? { now: () => performance.now(), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  let closed = false;

  // Lines reach the sink one at a time, in the order they were made, and a write is never left behind: the next one starts only when the
  // one before has ended. A line the sink has not stored within sinkTimeoutMs of being made counts as dropped (its write, if it had started,
  // may still land, but nothing is written after it until it does); one whose turn comes after that is not written at all. A sink that never
  // answers leaves one unfinished write and at most MAX_QUEUED_LINES lines waiting; the rest are dropped at once.
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  /** The timers of lines waiting or being written: unreferenced while the process lives on its own, referenced once `close` waits on them. */
  const sinkTimers = new Set<NodeJS.Timeout>();
  /** `make` builds the line when its turn comes (a gap reads the last frame that was saved by then). */
  const emit = (make: () => [FrameLine, Record<string, Uint8Array>?]): Promise<boolean> => {
    if (queued >= MAX_QUEUED_LINES) { counts.dropped += 1; return Promise.resolve(false); }
    queued += 1;
    let abandoned = false;
    let answered = false;
    let answer: (ok: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => { answer = (ok) => { if (answered) return; answered = true; if (!ok) counts.dropped += 1; resolve(ok); }; });
    const timer = setTimeout(() => { abandoned = true; answer(false); }, sinkTimeoutMs);
    sinkTimers.add(timer);
    if (closed) timer.ref?.(); else timer.unref?.();
    queue = queue.then(async () => {
      try {
        if (abandoned) return;
        const [line, blobs] = make();
        await options.sink(line, blobs);
        answer(true); // too late to count when the timeout already answered
      } catch { answer(false); } finally { clearTimeout(timer); sinkTimers.delete(timer); queued -= 1; }
    });
    return result;
  };
  const base = (c: Capture, t: number) => ({ channel: "live" as const, source: "browser" as const, t, ...(options.gen ? { gen: options.gen() } : {}), conv: c.conv });
  const gap = (c: Capture, reason: FrameGapData["reason"], from?: number, detail?: string): Promise<void> => {
    const t = options.clock();
    return emit(() => [{ ...base(c, t), kind: "frame.gap", data: { session: c.ref.id, from: from ?? c.lastFrameT ?? t, reason, ...(detail ? { detail } : {}) } }]).then((ok) => { if (ok) counts.gaps += 1; });
  };
  /** A credential may be on the page: the capture pauses, once, until the page navigates and the check is clean. */
  const hold = (c: Capture, why: string | null): void => {
    c.ready = null; c.waiting = null;
    if (c.paused) return;
    c.paused = true;
    c.navigated = false;
    void gap(c, "credential_on_page", undefined, why ?? "field");
  };
  const check = async (c: Capture): Promise<Verdict> => {
    try {
      options.onProbe?.(pclock.now());
      const answer = (await c.follower?.evaluate(CREDENTIAL_PROBE)) as { hold?: unknown; why?: unknown } | null | undefined;
      return answer && typeof answer.hold === "boolean" ? { hold: answer.hold, why: typeof answer.why === "string" ? answer.why : null } : "unchecked";
    } catch { return "unchecked"; } // a page that cannot be checked is not recorded
  };

  /** Every check of the page goes through here, one at a time: it is sent no earlier than PROBE_GAP_MS after the last one was sent, measured at the
   *  send, so a wait that ended late cannot be followed by one that ends on time and lands closer. Any half-open second then holds at most 20. */
  const paced = <T>(c: Capture, send: () => Promise<T>): Promise<T> => {
    let result: Promise<T>;
    c.pacing = c.pacing.then(async () => {
      for (;;) { const wait = c.lastProbeAt + PROBE_GAP_MS - pclock.now(); if (wait <= 0) break; await pclock.sleep(wait); }
      c.lastProbeAt = pclock.now();
      result = send();
    }).catch(() => { result ??= Promise.reject(new Error("the check was not sent")); });
    return c.pacing.then(() => result);
  };

  const arm = (c: Capture): void => {
    if (c.timer || c.busy || c.stopped || !c.ready) return;
    c.timer = setTimeout(() => { c.timer = null; void deliver(c); }, Math.max(0, spacingMs - (Date.now() - c.lastEmitMs)));
    c.timer.unref?.();
  };

  /** A frame is judged against the page the moment it arrives: the check that follows it stands for the page at its capture. A frame that
   *  arrives while a check runs waits for the next one; the one judged last is the one kept. */
  function judge(c: Capture): void {
    if (c.probing || c.stopped || !c.waiting || !c.follower) return;
    c.probing = true;
    let frame: Held | null = null;
    // The frame is the newest one when the check is sent: one that came while it waited for its turn replaces the older.
    void paced(c, async () => { frame = c.waiting; c.waiting = null; return c.stopped || !frame ? null : check(c); })
      .then((verdict) => { if (verdict === null || !frame) c.probing = false; else settle(c, frame, verdict); }, () => { c.probing = false; });
  }
  function settle(c: Capture, frame: Held, verdict: Verdict): void {
    c.probing = false;
    if (c.stopped) return;
    if (c.follower?.epoch() === frame.page.epoch) {
      if (verdict !== "unchecked" && verdict.hold) hold(c, verdict.why);
      else if (verdict !== "unchecked") { frame.verdict = verdict; c.ready = frame; }
    }
    judge(c);
    arm(c);
  }

  /** The judged frame whose turn has come: checked again now (a credential seen between its capture and now drops it), then kept. */
  async function deliver(c: Capture): Promise<void> {
    if (c.busy || c.stopped || !c.ready || !c.follower) return;
    c.busy = true;
    // The slot is taken when the check starts, so the next frame is a full spacing after this one whatever the check costs.
    c.lastEmitMs = Date.now();
    const frame = c.ready;
    c.ready = null;
    try {
      const verdict = await paced(c, async () => (c.stopped ? "unchecked" as const : check(c)));
      if (c.stopped) return;
      // A frame belongs to the page it showed: one held across a navigation or a move to another page is not kept.
      if (c.follower?.epoch() !== frame.page.epoch) return;
      if (verdict === "unchecked") return;
      if (verdict.hold) { hold(c, verdict.why); return; }
      // A pause lifts at a navigation, once the page holds no credential.
      if (c.paused) { if (!c.navigated) return; c.paused = false; }
      const size = jpegSize(frame.bytes) ?? (frame.page.deviceWidth > 0 ? { w: Math.min(frame.page.deviceWidth, maxWidth), h: Math.round(Math.min(frame.page.deviceWidth, maxWidth) * (frame.page.deviceHeight / frame.page.deviceWidth)) } : null);
      if (!size) return;
      const hash = createHash("sha256").update(frame.bytes).digest("hex");
      const t = options.clock();
      const saved = await emit(() => [{ ...base(c, t), kind: "frame", data: { session: c.ref.id, provider: c.provider, w: size.w, h: size.h, mime: "image/jpeg" }, blobs: [hash] }, { [hash]: new Uint8Array(frame.bytes) }]);
      if (saved) { counts.frames += 1; c.lastFrameT = t; }
      c.lastEmitMs = Date.now();
    } finally {
      c.busy = false;
      arm(c);
    }
  }

  function connect(c: Capture, url: string): void {
    c.follower = followPage(url, {
      frame(bytes, page) {
        if (c.stopped) return;
        // The newest frame wins: an older one still held is not worth keeping.
        c.waiting = { bytes, page };
        judge(c);
      },
      navigated() { c.navigated = true; },
      closed() {
        c.follower = null;
        if (c.stopped || closed) return;
        c.reconnect = setTimeout(() => { c.reconnect = null; if (!c.stopped && !closed) connect(c, url); }, 1_000);
        c.reconnect.unref?.();
      },
    }, { maxWidth, maxHeight: 2_000, quality });
  }

  function start(ref: LeaseRef, url: string, provider: BrowserProvider, conv: number | undefined): void {
    if (closed) return;
    const owner = conv ?? tagConversation(ref.tag);
    if (owner === null || owner === undefined) return;
    if (captures.get(ref.id)) return;
    const c: Capture = { ref, conv: owner, provider: provider.name, follower: null, lastFrameT: null, paused: false, navigated: false, ready: null, waiting: null, probing: false, lastProbeAt: -Infinity, pacing: Promise.resolve(), busy: false, timer: null, lastEmitMs: 0, stopped: false, reconnect: null };
    captures.set(ref.id, c);
    // A session first seen in this process that an earlier process already framed: the frames stopped when that process was killed.
    if (!made.has(ref.id)) {
      const from = options.lastFrameAt?.(ref.id) ?? null;
      if (from !== null) { c.lastFrameT = from; void gap(c, "process_killed", from); }
    }
    connect(c, url);
  }

  function stop(c: Capture): void {
    c.stopped = true;
    if (c.timer) clearTimeout(c.timer);
    if (c.reconnect) clearTimeout(c.reconnect);
    c.timer = null; c.reconnect = null; c.ready = null; c.waiting = null;
    c.follower?.close();
    c.follower = null;
    captures.delete(c.ref.id);
  }

  return {
    watch(provider, conv) {
      const watched = Object.create(provider) as BrowserProvider;
      watched.create = async (spec, signal) => {
        const ref = await provider.create(spec, signal);
        made.add(ref.id);
        return ref;
      };
      watched.attach = async (ref, signal) => {
        const target = await provider.attach(ref, signal);
        start(ref, target.sdkCdpUrl, provider, conv);
        return target;
      };
      watched.release = async (ref, signal) => {
        // The capture ends when the provider says the session is released: one it refuses to release is still running, and still recorded.
        await provider.release(ref, signal);
        const c = captures.get(ref.id);
        if (c) { stop(c); void gap(c, "session_released"); } // storage is not the browser call's to wait for: close() flushes
        else if (!closed) {
          // A release made by a process that never captured the session (a later one finishing an earlier one's release): the tile
          // ended where an earlier process's frames stopped.
          const from = options.lastFrameAt?.(ref.id) ?? null;
          const owner = conv ?? tagConversation(ref.tag);
          if (from !== null && owner !== null) void gap({ ref, conv: owner, lastFrameT: from } as Capture, "session_released");
        }
      };
      return watched;
    },
    pause(session) {
      const c = captures.get(session);
      if (!c || c.paused) return;
      c.paused = true;
      c.navigated = false;
      void gap(c, "credential_on_page", undefined, "host");
    },
    resume(session) {
      const c = captures.get(session);
      if (c) { c.paused = false; judge(c); arm(c); }
    },
    stats: () => ({ ...counts, sessions: captures.size }),
    async close() {
      closed = true;
      for (const t of sinkTimers) t.ref?.();
      for (const c of [...captures.values()]) stop(c);
      // What was already handed over is delivered first, for as long as the sink answers: every line has its own timeout, and a sink that
      // never answers is not waited on past one.
      let giveUp: NodeJS.Timeout | undefined;
      try { await Promise.race([queue, new Promise<void>((resolve) => { giveUp = setTimeout(resolve, sinkTimeoutMs + 50); })]); } finally { clearTimeout(giveUp); }
    },
  };
}
