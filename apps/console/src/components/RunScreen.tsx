import { Globe, Monitor, Smartphone, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientError } from "@/lib/client";
import { METERED } from "@/lib/computers";
import { httpHref } from "@/lib/safeUrl";
import type { ComputerHold, RunComputer, RunMachine } from "@/lib/v2";

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
 *  again, and a screen it showed reads as closed (none), whatever the last read said. A page opened on an ended run reads
 *  once, to know whether it had one. Any other failed read keeps the last answer, so a screen being watched isn't torn
 *  down by one bad poll. Nothing about the answer is logged. `held` puts a take-over's or hand-back's answer (who drives)
 *  in place until the next read. */
export function useRunScreen(read: (() => Promise<RunComputer>) | undefined, going: boolean, every = 3000): { view: ScreenView | null; held: (hold: ComputerHold) => void } {
  const [now, setNow] = useState<ScreenView | null>(null);
  // A caller the route refuses (401, 403) is read no more, whatever the run does.
  const [refused, setRefused] = useState(false);
  // The newest reader, so a page that passes a new function each render doesn't restart the reads.
  const reader = useRef(read);
  reader.current = read;
  // Whether a read has answered on this page: an ended run is then read no more (an off it said included), and a screen
  // it showed reads as closed, until it goes again (a follow-up).
  const answered = useRef(false);
  const has = !!read;
  useEffect(() => {
    if (!has || refused) return;
    if (!going && answered.current) { setNow((prev) => (prev ? closed(prev) : prev)); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const once = async () => {
      try {
        const next = await reader.current!();
        if (!alive) return;
        answered.current = true;
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
      if (alive && going) timer = setTimeout(() => void once(), every);
    };
    void once();
    return () => { alive = false; clearTimeout(timer); };
  }, [has, going, every, refused]);
  const held = useCallback((hold: ComputerHold) => setNow((prev) => (prev && prev.state === "live" && prev.hold !== hold ? { ...prev, hold } : prev)), []);
  return { view: now, held };
}

const same = (prev: ScreenView | null, next: Exclude<RunComputer, { state: "off" }>): boolean =>
  !!prev && prev.state !== "signed_out" && prev.state === next.state && prev.kind === next.kind && prev.hold === next.hold && (prev.state !== "live" || (next.state === "live" && prev.viewer === next.viewer));

/** A screen that closed with its run: `none`, of the same kind, the agent's. */
const closed = (from: ScreenView | RunComputer): ScreenView | null => (from.state === "off" ? null : from.state === "signed_out" ? from : { state: "none", kind: from.kind, hold: "agent" });

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
  const src = screen?.state === "live" ? framedViewer(screen.viewer, runId) : undefined;
  const kind: Kind = screen && screen.state !== "signed_out" ? screen.kind : machine?.kind ?? "browser";
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
  return (
    <section aria-label="Screen" className="border">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="caps text-[12px] font-semibold">{live ? "Live" : NAMES[kind]}</span>
        <span className="flex-1 font-mono text-[12px] text-muted-foreground">{live ? `${DRIVES[live.hold]} · ${kind}` : ""}</span>
        {controls && (controls.hold === "person"
          ? <Button size="sm" variant="solid" disabled={busy} onClick={() => void act(onHand)}>Hand back</Button>
          : <Button size="sm" variant="solid" disabled={busy || controls.hold === "pending"} onClick={() => void act(onTake)}>{controls.hold === "pending" ? "Taking over" : "Take over"}</Button>)}
      </header>
      {metered && kind !== "browser" && <p className="border-b px-4 py-2 text-[12px] text-muted-foreground">{METERED}</p>}
      {said && <p className="border-b px-4 py-2 text-[12px] text-warning-text" role="alert">{said}</p>}
      {live && src
        // The viewer's page needs its own scripts, and its own origin: its WebSocket goes to this server, which checks the
        // session cookie and the Origin, and it clears the fragment from its own history. A browser's address bar is a form
        // (its own script reads it). Nothing else: no popups, no navigating the console.
        ? <iframe key={session.current.n} src={src} title="The run's screen" referrerPolicy="no-referrer" sandbox="allow-forms allow-scripts allow-same-origin" className={kind === "phone" ? "mx-auto block aspect-[9/19] h-[70vh] max-w-full bg-background" : "block aspect-[16/10] w-full bg-background"} />
        : <p className="px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">{words(kind, screen, machine, opens, followUp)}</p>}
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
  if (opens) return kind === "browser" ? "Waiting for the browser. The agent's page shows here once it opens one." : `Waiting for the ${kind}. Its screen shows here once it is up.`;
  return `The ${kind} closed when the run ended.${followUp ? " A follow-up opens a new one if the agent needs it." : ""}`;
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
