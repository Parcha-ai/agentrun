import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { claudeLoginView, LOGIN_ROW, LOGIN_RUNS, loginSignedInAs, NO_CLI, ONLY_ME, ONLY_ME_WHY, OTHER_MACHINE, PLACES, SIGNED_OUT, UNKNOWN } from "@/lib/claudeLogin";
import { type Client, ClientError } from "@/lib/client";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ClaudeLoginView } from "@/lib/v2";

/** How often a signed-out login is read after the CLI's sign-in started here, while the page is in view, and for how long. */
const POLL_MS = 2_000;
const POLL_FOR_MS = 10 * 60_000;

const words = (e: unknown): string => (e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e));

const STATE: Record<ClaudeLoginView["state"], { tone: ChipTone; words: string }> = {
  off: { tone: "plain", words: "off" },
  other_machine: { tone: "warning", words: "another machine" },
  signed_in: { tone: "success", words: "signed in" },
  signed_out: { tone: "warning", words: "not signed in" },
  no_cli: { tone: "plain", words: "no CLI yet" },
  unknown: { tone: "warning", words: "status unknown" },
};

/** Settings → Model keys' "Use Claude Code's login on this machine" row, over /v2/settings/claude-login. Off: where the
 *  login is (AgentRun's own by default, this machine's own by choice) and the owner's word that only they run agents
 *  here, then Turn on; where the server refuses the mode, its one line instead. On: what the CLI says (who and which
 *  plan), or the command that signs it in on the server's machine and, where the browser is on that machine, a button
 *  that starts the CLI's own sign-in; Turn off. Nothing on a server with the mode switched off (its GET is a 404).
 *  `onChange`: after a turn on or off, which change what Claude Agent runs on. */
export function ClaudeLoginRow({ v2, writable, whyNot = "sign_in", onChange }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot; onChange?: () => void }) {
  const [view, setView] = useState<ClaudeLoginView | null>(null);
  const [place, setPlace] = useState<ClaudeLoginView["place"]>("agentrun");
  const [onlyMe, setOnlyMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // A read's answer is shown only if no other read or write began or ended since it was asked (`asked`), and none starts
  // while a write is out (`writing`): a status read that raced a turn on or off never puts back what it replaced.
  const asked = useRef(0);
  const writing = useRef(false);
  const reading = useRef(false);
  useEffect(() => {
    let live = true;
    v2.claudeLogin().then((body) => { if (live) setView(claudeLoginView(body)); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [v2]);
  const refresh = () => {
    if (reading.current || writing.current) return;
    reading.current = true;
    const n = ++asked.current;
    v2.claudeLogin().then((body) => {
      const next = claudeLoginView(body);
      if (n === asked.current && next) setView(next);
    }, () => {}).finally(() => { reading.current = false; });
  };

  // After the CLI's sign-in started here, the status is read until it says signed in, so the row says so by itself.
  const waiting = startedAt !== null && view?.state !== "signed_in";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - startedAt! > POLL_FOR_MS) { setStartedAt(null); return; }
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [v2, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  // A sign-in run in a terminal shows when the person comes back to this page.
  const awaitingLogin = view?.state === "signed_out" || view?.state === "no_cli" || view?.state === "unknown";
  useEffect(() => {
    if (!awaitingLogin) return;
    const back = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [v2, awaitingLogin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return null;
  const act = async (write: () => Promise<ClaudeLoginView>, changes: boolean) => {
    setProblem(null); setBusy(true);
    writing.current = true;
    asked.current++;
    try {
      setView(await write());
      if (changes) onChange?.();
      return true;
    } catch (e) {
      setProblem(words(e));
      return false;
    } finally {
      asked.current++;
      writing.current = false;
      setBusy(false);
    }
  };
  const state = STATE[view.state];
  const on = view.state !== "off";
  const command = <pre className="overflow-x-auto border bg-card p-3 font-mono text-small"><code>{view.command}</code></pre>;
  return (
    <li aria-label={LOGIN_ROW} className="border-b p-4 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-prose font-semibold">{LOGIN_ROW}</span>
        <Chip tone={state.tone}>{state.words}</Chip>
      </p>
      <p className="mt-1.5 font-mono text-small text-muted-foreground">{LOGIN_RUNS}</p>
      <div className="mt-3 space-y-3">
        {view.state === "signed_in" && <p className="text-body font-semibold">{loginSignedInAs(view)}</p>}
        {view.state === "other_machine" && <p className="text-body">{OTHER_MACHINE}</p>}
        {(view.state === "signed_out" || view.state === "no_cli" || view.state === "unknown") && (
          <div className="space-y-2">
            <p className="text-body">{view.state === "signed_out" ? SIGNED_OUT : view.state === "no_cli" ? NO_CLI : UNKNOWN}</p>
            {command}
            <div className="flex flex-wrap gap-2">
              {writable && view.can_start && view.state !== "no_cli" && (
                <Button type="button" size="sm" variant="solid" disabled={busy || waiting} onClick={() => void act(() => v2.startClaudeLogin(), false).then((ok) => ok && setStartedAt(Date.now()))}>
                  {waiting ? "Waiting for the browser…" : "Open the CLI's sign-in here"}
                </Button>
              )}
              <Button type="button" size="sm" disabled={busy} onClick={refresh}>Check again</Button>
            </div>
          </div>
        )}
        {!on && view.refused && <p className="text-body" role="status">{view.refused}</p>}
        {!on && !view.refused && !writable && <p className="text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
        {!on && !view.refused && writable && (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void act(() => v2.turnOnClaudeLogin(place), true); }}>
            <fieldset className="space-y-1">
              <legend className="caps mb-1 text-small font-semibold">The login it uses</legend>
              {(Object.keys(PLACES) as ClaudeLoginView["place"][]).map((p) => (
                <label key={p} className="flex items-center gap-2 text-body">
                  <input type="radio" name="claude-login-place" value={p} className="accent-primary" checked={place === p} onChange={() => setPlace(p)} />
                  {PLACES[p]}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-body">
              <input type="checkbox" name="only_me" className="accent-primary" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
              {ONLY_ME}
            </label>
            <p className="text-small text-muted-foreground">{ONLY_ME_WHY}</p>
            <Button type="submit" size="sm" variant="solid" disabled={!onlyMe || busy}>Turn on</Button>
          </form>
        )}
        {on && writable && <Button size="sm" disabled={busy} onClick={() => void act(() => v2.turnOffClaudeLogin(), true).then((ok) => ok && setStartedAt(null))}>Turn off</Button>}
        {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      </div>
    </li>
  );
}
