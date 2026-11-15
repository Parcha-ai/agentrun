import { Globe, Maximize2, Minimize2, Monitor, Smartphone, Terminal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientError } from "@/lib/client";
import { METERED } from "@/lib/computers";
import { httpHref } from "@/lib/safeUrl";
import { cn } from "@/lib/utils";
import type { ComputerHold, RunComputer, RunMachine } from "@/lib/v2";

/** The run page's tab body keeps this much padding below its content (its py-8). */
const PANE_BELOW = 32;
/** A phone's frame is never shorter than this (a short page scrolls instead) nor taller than 70% of the window. */
const PHONE_MIN = 360;
const PHONE_MOST = 0.7;

/** The height a page's scroll pane shows below `el`, as if scrolled to its top: the pane's visible height less where
 *  `el` starts in it and the padding under it. Without a pane, the window's. */
export function roomBelow(el: HTMLElement, pane: HTMLElement | null): number {
  const top = el.getBoundingClientRect().top;
  if (!pane) return window.innerHeight - (top + window.scrollY) - PANE_BELOW;
  const at = top - pane.getBoundingClientRect().top + pane.scrollTop;
  return pane.clientHeight - at - PANE_BELOW;
}

/** A phone frame's height for `room` px of page below it, in a window `viewport` px tall. */
export const phoneHeight = (room: number, viewport: number): number => Math.round(Math.max(PHONE_MIN, Math.min(room, viewport * PHONE_MOST)));

/** The run's screen as the page shows it: the server's answer (never `off`: that is no screen), or signed out (a read
 *  refused 401), said in the tab. */
export type ScreenView = Exclude<RunComputer, { state: "off" }> | { state: "signed_out" };

/** The run's screen, every kind, read from GET /v2/runs/{id}/computer and read again every `every` ms while the run is
 *  `going`: not over (completed, failed, cancelled), so a paused or waiting run is read on too. `view` is null until the
 *  first answer, and while it is `off`. `off` is read from the server's keys now, but a going run's process holds the key
 *  it launched with and may still open its computer, so it is read on; a caller the route refuses (401, 403) is read no
 *  more: signed out (401) reads as `signed_out`, so the tab says why it closed (in the console the same 401 also turns the
 *  page to its sign-in, once the session read again says it ended; the tab's words are what shows meanwhile, and where no
 *  such check runs); a 403 (a token, never a session) has no screen. An ended run has nothing to watch: it is not read
 *  again (but once, when the last read said its computer was unopened, since it may have opened one after that read),
 *  and a screen it showed reads as closed (none), whatever the last read said. A page opened on an ended run reads
 *  once, to know whether it had one. Any other failed read keeps the last answer, so a screen being watched isn't torn
 *  down by one bad poll. Nothing about the answer is logged. `held` puts a take-over's or hand-back's answer (who drives)
 *  in place until the next read. While a change is on its way the next read comes `soon` instead: the screen being
 *  opened (none, opening), a take-over waiting for the agent's step (pending), and for HURRY_MS after the page's own
 *  take-over or hand-back, whose answer is read right after its row is written, before the run applies it. So the first
 *  frame and who drives show when they happen, not up to a whole `every` later. */
export function useRunScreen(read: (() => Promise<RunComputer>) | undefined, going: boolean, every = 3000, soon = Math.min(every, SOON_MS), starting = false): { view: ScreenView | null; held: (hold: ComputerHold) => void } {
  const [now, setNow] = useState<ScreenView | null>(null);
  // A caller the route refuses (401, 403) is read no more, whatever the run does.
  const [refused, setRefused] = useState(false);
  // The newest reader, so a page that passes a new function each render doesn't restart the reads.
  const reader = useRef(read);
  reader.current = read;
  // Whether a read has answered on this page: an ended run is then read no more (an off it said included), and a screen
  // it showed reads as closed, until it goes again (a follow-up).
  const answered = useRef(false);
  // Whether the last answer was a computer the run hadn't opened: one may have opened since, so the end reads once more
  // before it says the run didn't open one.
  const unopened = useRef(false);
  // Until when the reads come soon after the page's own take-over or hand-back, and the running reads' way to bring the
  // next one forward (none while no read is waiting).
  const hurryUntil = useRef(0);
  const hurry = useRef<(() => void) | null>(null);
  // The desktop or phone this page saw live while the run goes. Its claim holds it from the run's start to its end, so
  // once it was live, an answer of opening (its viewer gone, the run not yet read as ended) is the one that was let go:
  // released, never one to wait for. A new turn opens a new one, which is waited for: the memory goes when the run ends,
  // and when a turn's claim is `starting` it (the run queued: a follow-up after the run completed or was stopped).
  const wasLive = useRef<RunMachine["kind"] | null>(null);
  useEffect(() => { if (starting) wasLive.current = null; }, [starting]);
  const has = !!read;
  useEffect(() => {
    if (!has || refused) return;
    if (!going) wasLive.current = null;
    if (!going && answered.current && !unopened.current) { setNow((prev) => (prev ? closed(prev) : prev)); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { hurry.current = null; void once(); }, ms); hurry.current = () => later(soon); };
    // Whether the last answer said a change is on its way: a failed read keeps it, as it keeps the last answer.
    let onItsWay = false;
    const once = async () => {
      try {
        const read = await reader.current!();
        if (!alive) return;
        answered.current = true;
        if (read.state === "live") wasLive.current = read.kind;
        const next: RunComputer = read.state === "none" && read.session === "opening" && read.kind !== "browser" && read.kind === wasLive.current ? { ...read, session: "closed" } : read;
        unopened.current = next.state === "none" && next.session === "unopened";
        onItsWay = (next.state === "none" && next.session === "opening") || (next.state === "live" && next.hold === "pending");
        if (next.state === "off") setNow(null);
        // An ended run's screen is closed, whatever it last said.
        else if (!going) setNow(closed(next));
        // A same answer keeps the same object, so a live viewer's iframe is not touched by a poll.
        else setNow((prev) => (same(prev, next) ? prev : next));
      } catch (e) {
        if (!alive) return;
        if (e instanceof ClientError && e.status === 401) { setRefused(true); setNow((prev) => (prev ? { state: "signed_out" } : null)); return; }
        if (e instanceof ClientError && e.status === 403) { setRefused(true); setNow(null); return; }
      }
      if (alive && going) later(onItsWay || Date.now() < hurryUntil.current ? soon : every);
    };
    void once();
    return () => { alive = false; clearTimeout(timer); hurry.current = null; };
  }, [has, going, every, soon, refused]);
  const held = useCallback((hold: ComputerHold) => {
    setNow((prev) => (prev && prev.state === "live" && prev.hold !== hold ? { ...prev, hold } : prev));
    hurryUntil.current = Date.now() + HURRY_MS;
    hurry.current?.();
  }, []);
  return { view: now, held };
}

/** The read's pace while a change is on its way, in ms; and how long it keeps that pace after the page's own take-over
 *  or hand-back. */
const SOON_MS = 400;
const HURRY_MS = 4000;

const same = (prev: ScreenView | null, next: Exclude<RunComputer, { state: "off" }>): boolean =>
  !!prev && prev.state !== "signed_out" && prev.state === next.state && prev.kind === next.kind && prev.hold === next.hold && (prev.state !== "live" || (next.state === "live" && prev.viewer === next.viewer))
  && (prev.state !== "none" || (next.state === "none" && prev.session === next.session && prev.ended?.at === next.ended?.at));

/** A screen that closed with its run: `none`, of the same kind, the agent's; one the run never opened stays unopened. */
const closed = (from: ScreenView | RunComputer): ScreenView | null =>
  from.state === "off" ? null : from.state === "signed_out" ? from : { state: "none", kind: from.kind, hold: "agent", session: from.state === "none" && from.session === "unopened" ? "unopened" : "closed" };

type Kind = RunMachine["kind"];
const ICONS = { browser: Globe, desktop: Monitor, phone: Smartphone, sandbox: Terminal } as const;
const NAMES: Record<Kind, string> = { browser: "Browser", desktop: "Desktop", phone: "Phone", sandbox: "Sandbox" };
const DRIVES: Record<ComputerHold, string> = { agent: "The agent drives", pending: "Yours after the agent's step", person: "You drive" };

/** The Screen tab, one panel for every kind of computer: the run's screen watched through the server's own viewer (a
 *  browser's page, a desktop's or a phone's screen), that it waits for one, or that its computer has none (a sandbox).
 *  `screen` is GET /computer's answer; `machine` the run read's computer (its kind and provider, a sandbox's too), for a
 *  computer the live view has no answer for yet. The viewer (a same-origin path, its token in the fragment) is the
 *  iframe's src and nothing else: never the address bar, the history, storage, a log or an error. A new session is a new
 *  viewer: the iframe is made again for it. A browser is taken over and handed back in its own viewer; a desktop or a
 *  phone here, with Take over and Hand back (`onTake`, `onHand`: each resolves with the refusal to say, or null). A
 *  metered provider's line shows for every kind but the browser. */
export function ScreenPanel({ runId, screen, machine, opens, followUp, metered, onTake, onHand }: {
  /** The run whose screen this is: only a viewer under its own path is framed. */
  runId: string;
  screen: ScreenView | null;
  machine?: RunMachine;
  /** Whether the run can still open its computer: queued, working, waiting on its question with its process (and any
   *  session) held, or a paused workflow. Otherwise `none` is a screen that closed with the run, never one to wait for. */
  opens: boolean;
  /** Whether the ended run takes a follow-up: its turn runs in a new process, which opens a new session if the agent
   *  uses its computer. */
  followUp: boolean;
  /** Whether the run's computer's provider is metered (GET /computers). */
  metered: boolean;
  onTake?: () => Promise<string | null>;
  onHand?: () => Promise<string | null>;
}) {
  // Each viewer gets an iframe of its own (a new session is a new page); the key is a count, never the viewer itself.
  const session = useRef({ viewer: "", n: 0 });
  if (screen?.state === "live" && screen.viewer !== session.current.viewer) session.current = { viewer: screen.viewer, n: session.current.n + 1 };
  const kind: Kind = screen && screen.state !== "signed_out" ? screen.kind : machine?.kind ?? "browser";
  // A desktop's or a phone's Take over and Hand back are this header's: the viewer is told so (hands=page, in the
  // fragment beside its token), and its own bar shows neither, nor who drives. A browser's are its viewer's own.
  const framed = screen?.state === "live" ? framedViewer(screen.viewer, runId) : undefined;
  const src = framed && kind !== "browser" ? `${framed}${framed.includes("#") ? "&" : "#"}hands=page` : framed;
  const Icon = ICONS[kind];
  const live = screen?.state === "live" ? screen : null;
  // Take over and Hand back, here for a desktop or a phone up now (a browser's are its viewer's own): one in flight at a
  // time, and a refusal said under the header.
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const act = async (go: (() => Promise<string | null>) | undefined) => {
    if (!go || busy) return;
    setBusy(true); setSaid(null);
    try { setSaid(await go()); } finally { setBusy(false); }
  };
  const controls = live && src && kind !== "browser" ? live : null;
  // Fill the window: the live view grows to the whole window, and the viewer inside draws the page as large as it fits at
  // the page's own shape (letterboxed), mapping each click through the canvas it drew, so input stays exact at any size.
  // Esc, or the same button, puts it back. The iframe stays the same element (only its frame's classes change), so the
  // viewer keeps its connection.
  const [full, setFull] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const wasFull = useRef(false);
  const showing = Boolean(live && src);
  useEffect(() => { if (!showing) setFull(false); }, [showing]);
  // A phone is tall: its frame takes the height the run page shows below it (phoneHeight), so the whole phone is on
  // screen at once, its bottom (the keyboard, the nav bar) never under the composer.
  const [phoneH, setPhoneH] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = frame.current;
    if (kind !== "phone" || full || !showing || !el) return;
    const pane = el.closest<HTMLElement>("[data-scroll-pane]");
    const fit = () => setPhoneH(phoneHeight(roomBelow(el, pane), window.innerHeight));
    fit();
    // The pane's size, and its content's: a card that comes or goes above the frame moves it, the pane staying as it was.
    const watch = typeof ResizeObserver === "function" && pane ? new ResizeObserver(fit) : undefined;
    if (pane) for (const box of [pane, ...pane.children]) watch?.observe(box);
    window.addEventListener("resize", fit);
    return () => { watch?.disconnect(); window.removeEventListener("resize", fit); };
  }, [kind, full, showing, said, metered, session.current.n]);
  // While it fills the window it is a modal dialog: focus moves into its bar, Tab stays among its bar and the viewer, and
  // closing puts the focus back on the button that opened it (when the screen is still up).
  useEffect(() => {
    if (full) { wasFull.current = true; box.current?.querySelector<HTMLElement>("button")?.focus(); return; }
    if (wasFull.current) { wasFull.current = false; opener.current?.focus(); }
  }, [full]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setFull(false); return; }
      if (e.key !== "Tab" || !box.current) return;
      const stops = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), iframe")];
      if (!stops.length) return;
      const first = stops[0]!, last = stops[stops.length - 1]!;
      const at = document.activeElement;
      if (!box.current.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    const onInnerKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    document.addEventListener("keydown", onKey);
    // Keys typed in the viewer go to its own document (same origin): Esc there puts the view back too. The listener goes
    // on each page the iframe loads (a new session is a new iframe, and a reload a new document), never only the first.
    const el = frame.current;
    let inner: Window | null = null;
    const attach = () => {
      try { inner?.removeEventListener("keydown", onInnerKey, true); } catch { /* that page went away */ }
      try { inner = el?.contentWindow ?? null; inner?.addEventListener("keydown", onInnerKey, true); } catch { inner = null; }
    };
    attach();
    el?.addEventListener("load", attach);
    return () => {
      document.removeEventListener("keydown", onKey);
      el?.removeEventListener("load", attach);
      try { inner?.removeEventListener("keydown", onInnerKey, true); } catch { /* the viewer's page went away */ }
    };
  }, [full, session.current.n]);
  const who = live ? (kind === "browser" ? "browser · take over in the view below" : `${DRIVES[live.hold]} · ${kind}`) : "";
  const hands = controls && (controls.hold === "person"
    ? <Button size="sm" variant="solid" disabled={busy} onClick={() => void act(onHand)}>Hand back</Button>
    : <Button size="sm" variant="solid" disabled={busy || controls.hold === "pending"} onClick={() => void act(onTake)}>{controls.hold === "pending" ? "Taking over" : "Take over"}</Button>);
  const fill = showing && (
    <Button ref={full ? undefined : opener} size="sm" variant="ghost" onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full window (Esc)" : "Fill the window"} title={full ? "Exit full window (Esc)" : "Fill the window"} aria-pressed={full}>
      {full ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
    </Button>
  );
  return (
    <section aria-label="Screen" className="border">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="caps text-small font-semibold">{live ? "Live" : NAMES[kind]}</span>
        {/* Who drives, for a desktop or a phone: GET /computer's hold is theirs. A browser is taken over in its own viewer,
            which says who has it; the served hold doesn't follow that take, so it isn't said here. */}
        <span className="flex-1 font-mono text-small text-muted-foreground">{who}</span>
        {!full && fill}
        {!full && hands}
      </header>
      {metered && kind !== "browser" && <p className="border-b px-4 py-2 text-small text-muted-foreground">{METERED}</p>}
      {!full && said && <p className="border-b px-4 py-2 text-small text-warning-text" role="alert">{said}</p>}
      {live && src
        // The viewer's page needs its own scripts, and its own origin: its WebSocket goes to this server, which checks the
        // session cookie and the Origin, and it clears the fragment from its own history. A browser's address bar is a form
        // (its own script reads it). Nothing else: no popups, no navigating the console.
        ? <div ref={box} data-testid="screen-frame" className={full ? "fixed inset-0 z-dialog flex flex-col bg-background" : undefined} role={full ? "dialog" : undefined} aria-modal={full ? true : undefined} aria-label={full ? "The run's screen, filling the window" : undefined}>
            {full && (
              <div className="flex items-center gap-3 border-b bg-background px-4 py-2 text-foreground">
                <span className="flex-1 font-mono text-small">{who}</span>
                {fill}
                {hands}
              </div>
            )}
            {/* A refused Take over or Hand back, said where the person is looking. */}
            {full && said && <p className="border-b px-4 py-2 text-small text-warning-text" role="alert">{said}</p>}
            <iframe ref={frame} key={session.current.n} src={src} title="The run's screen" referrerPolicy="no-referrer" sandbox="allow-forms allow-scripts allow-same-origin" className={full ? "block min-h-0 w-full flex-1 bg-background" : kind === "phone" ? cn("mx-auto block aspect-[9/19] max-w-full bg-background", phoneH === undefined && "h-[70vh]") : "block aspect-[16/10] w-full bg-background"} style={!full && kind === "phone" && phoneH !== undefined ? { height: `${phoneH}px` } : undefined} />
          </div>
        : <p className="px-4 py-12 text-center font-mono text-body text-muted-foreground">{words(kind, screen, machine, opens, followUp)}</p>}
    </section>
  );
}

/** What the Screen tab says with nothing to frame. */
function words(kind: Kind, screen: ScreenView | null, machine: RunMachine | undefined, opens: boolean, followUp: boolean): string {
  // A viewer that is not this run's own on this origin: said, never framed, and its value not shown.
  if (screen?.state === "live") return "The live view can't be shown here.";
  if (screen?.state === "signed_out") return "Signed out: sign in to watch.";
  if (kind === "sandbox") return "A sandbox has no screen. What the agent runs in it is on the timeline.";
  if (machine?.state === "failed") return `The ${kind} didn't start.${machine.why ? ` ${machine.why}` : ""}`;
  // Let go while the run waited for its person: said, with when, and that a new one opens when the run goes on. Never
  // "waiting for the browser" here: nothing is opening one until the person answers.
  if (opens && screen?.state === "none" && screen.ended) return `${screen.ended.why} (${clock(screen.ended.at)}). A new browser opens when the run goes on.`;
  const session = screen?.state === "none" ? screen.session : undefined;
  // None asked for so far (a run that only fetched pages, say): said plainly, never "waiting", since the agent may never
  // open one.
  if (session === "unopened") {
    if (!opens) return `This run didn't open its ${kind}.${followUp ? " A follow-up opens one if the agent needs it." : ""}`;
    return kind === "browser" ? "This run hasn't opened its browser. The agent's page shows here if it opens one." : `This run hasn't opened its ${kind}. Its screen shows here if the agent opens one.`;
  }
  // Opened, and not up now, while the run goes on: a browser opens again when the agent asks; a desktop or a phone, held
  // to the run's end, was let go (useRunScreen reads it so once it was live), and the run is ending.
  if (opens && session === "closed") return kind === "browser" ? "The run's browser isn't open now. The agent's page shows here if it opens one again." : `This ${kind} has been released.`;
  // Being opened (or no answer read yet).
  if (opens) return kind === "browser" ? "Waiting for the browser. The agent's page shows here once it opens one." : `Waiting for the ${kind}. Its screen shows here once it is up.`;
  return `The ${kind} closed when the run ended.${followUp ? " A follow-up opens a new one if the agent needs it." : ""}`;
}

/** An ISO time as the page's local clock, `HH:MM`, or the text itself when it doesn't parse. */
function clock(at: string): string {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? at : `at ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** The served viewer as the iframe's src: resolved against this page's origin (it is a same-origin path, its token in the
 *  fragment), an http(s) URL (httpHref), on this origin, under this run's own live-view path (/computer/live/). Anything else: undefined. */
export function framedViewer(viewer: string, runId: string): string | undefined {
  let resolved: string;
  try { resolved = new URL(viewer, location.origin).href; } catch { return undefined; }
  const href = httpHref(resolved);
  if (!href) return undefined;
  const url = new URL(href);
  return url.origin === location.origin && url.pathname.startsWith(`/v2/runs/${encodeURIComponent(runId)}/computer/live/`) ? href : undefined;
}
