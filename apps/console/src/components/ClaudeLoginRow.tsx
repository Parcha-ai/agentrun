import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { canSignOut, checksFolder, claudeLoginView, KEPT_REFUSED, LOGIN_ROW, LOGIN_RUNS, type LoginView, loginSignedInAs, MACHINE_DEFAULT_FOLDER, machineCredentials, NO_CLI, ONLY_ME, ONLY_ME_FIRST, ONLY_ME_WHY, OTHER_MACHINE, placeWords, SIGN_OUT_ASK, SIGNED_OUT, SIGNED_OUT_HERE, signInWords, UNKNOWN } from "@/lib/claudeLogin";
import { type Client, ClientError } from "@/lib/client";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ClaudeLoginView } from "@/lib/v2";

/** How often the login is read while the server says the CLI's sign-in it started waits for the browser, while the page is
 *  in view. The server ends the sign-in at its limit, which ends the reading too. */
const POLL_MS = 2_000;

const words = (e: unknown): string => (e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e));

const STATE: Record<ClaudeLoginView["state"], { tone: ChipTone; words: string }> = {
  off: { tone: "plain", words: "off" },
  other_machine: { tone: "warning", words: "another machine" },
  refused: { tone: "warning", words: "refused here" },
  signed_in: { tone: "success", words: "signed in" },
  signed_out: { tone: "warning", words: "not signed in" },
  no_cli: { tone: "plain", words: "no CLI yet" },
  unknown: { tone: "warning", words: "status unknown" },
};

/** Settings → Model keys' "Use Claude Code's login on this machine" row, over /v2/settings/claude-login. Off: where the
 *  login is (AgentRun's own by default, this machine's own by choice) and the owner's word that only they run agents
 *  here, then Turn on; where the server refuses the mode, its one line instead. On: what the CLI says (who and which
 *  plan), or the command that signs it in on the server's machine and, where the browser is on that machine, a button
 *  that starts the CLI's own sign-in; Turn off. On but kept while the server refuses its folders (`refused`): that, and
 *  the server's words for why; Turn off. Nothing on a server with the mode switched off (its GET is a 404).
 *  `available`: capabilities' `features.claude_login`; false (switched off, or capabilities not read yet) asks nothing, so
 *  the browser never logs the 404. `onChange`: after a turn on or off, which change what Claude Agent runs on. */
export function ClaudeLoginRow({ v2, writable, whyNot = "sign_in", onChange, available = true }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot; onChange?: () => void; available?: boolean }) {
  const [view, setView] = useState<LoginView | null>(null);
  const [place, setPlace] = useState<ClaudeLoginView["place"]>("agentrun");
  const [onlyMe, setOnlyMe] = useState(false);
  const onlyMeFirst = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Sign out asks first (`confirming`), then says what became of it (`signedOut`) until the mode is on again: the turn-on
  // (or a read that finds it on) drops the words for good, so a later Turn off never shows them.
  const [confirming, setConfirming] = useState(false);
  const [signedOut, setSignedOut] = useState<string | null>(null);
  const modeOn = view !== null && view.state !== "off";
  useEffect(() => { if (modeOn) setSignedOut(null); }, [modeOn]);
  // A read's answer is shown only if no other read or write began or ended since it was asked (`asked`), and none starts
  // while a write is out (`writing`): a status read that raced a turn on or off never puts back what it replaced.
  const asked = useRef(0);
  const writing = useRef(false);
  const reading = useRef(false);
  // Switched off (capabilities changed): the row goes, a sign-in it waited for is dropped, no read starts, and a read
  // still out never puts the row back.
  const availableNow = useRef(available);
  availableNow.current = available;
  useEffect(() => {
    if (!available) { asked.current++; setView(null); return; }
    let live = true;
    v2.claudeLogin().then((body) => { if (live) setView(claudeLoginView(body)); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [v2, available]);
  const refresh = () => {
    if (!availableNow.current || reading.current || writing.current) return;
    reading.current = true;
    const n = ++asked.current;
    v2.claudeLogin().then((body) => {
      const next = claudeLoginView(body);
      if (n === asked.current && next && availableNow.current) setView(next);
    }, () => {}).finally(() => { reading.current = false; });
  };

  // While the server says the CLI's sign-in it started waits for the browser (after a reload too), the login is read until
  // it is signed in or the sign-in ends, so the row says what became of it by itself.
  const waiting = view?.state !== "signed_in" && view?.sign_in?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
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
      const next = claudeLoginView(await write());
      if (availableNow.current) setView(next);
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
  // AgentRun's own login removed and the mode off (the answer's view): the row reads off, and Turn on then finds no login
  // and offers the sign-in. Where the CLI didn't confirm its own sign-out, the server's words say what may remain.
  const signOut = async () => {
    let said: string | null = null;
    const done = await act(async () => {
      const out = await v2.signOutClaudeLogin();
      said = out.confirmed ? SIGNED_OUT_HERE : out.message || SIGNED_OUT_HERE;
      return out.login;
    }, true);
    if (!done) return;
    setConfirming(false);
    setSignedOut(said);
  };
  const state = STATE[view.state];
  const on = view.state !== "off";
  const command = <pre className="overflow-x-auto border bg-card p-3 font-mono text-small"><code>{view.command}</code></pre>;
  const signIn = signInWords(view);
  // The folder the status is read from, and, for this machine's login where the server saw no CLAUDE_CONFIG_DIR, how a
  // Claude Code that keeps it elsewhere is found. An older server names no folder: no line. A refused login's CLI is not
  // asked: no line.
  const folder = on && view.state !== "other_machine" && view.state !== "refused" && view.folder !== undefined && (
    <div className="space-y-1">
      <p className="text-small text-muted-foreground">{checksFolder(view.folder)}</p>
      {view.place === "machine" && view.machine?.source === "default" && <p className="text-small text-muted-foreground">{MACHINE_DEFAULT_FOLDER}</p>}
      {view.place === "machine" && typeof view.machine?.credentials === "string" && <p className="text-small text-muted-foreground">{machineCredentials(view.machine.credentials)}</p>}
    </div>
  );
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
        {view.state === "refused" && (
          <div className="space-y-1">
            <p className="text-body">{KEPT_REFUSED}</p>
            {view.refused && <p className="text-body" role="status">{view.refused}</p>}
          </div>
        )}
        {folder}
        {(view.state === "signed_out" || view.state === "no_cli" || view.state === "unknown") && (
          <div className="space-y-2">
            <p className="text-body">{view.state === "signed_out" ? SIGNED_OUT : view.state === "no_cli" ? NO_CLI : UNKNOWN}</p>
            {command}
            {signIn && <p className="text-body" role="status">{signIn}</p>}
            <div className="flex flex-wrap gap-2">
              {writable && view.can_start && view.state !== "no_cli" && (
                <Button type="button" size="sm" variant="solid" disabled={busy || waiting} onClick={() => void act(() => v2.startClaudeLogin(), false)}>
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
              {(["agentrun", "machine"] as const).map((p) => (
                <label key={p} className="flex items-center gap-2 text-body">
                  <input type="radio" name="claude-login-place" value={p} className="accent-primary" checked={place === p} onChange={() => setPlace(p)} />
                  {placeWords(p, view)}
                </label>
              ))}
            </fieldset>
            {place === "machine" && view.machine?.source === "default" && <p className="text-small text-muted-foreground">{MACHINE_DEFAULT_FOLDER}</p>}
            <label className="flex items-center gap-2 text-body">
              <input type="checkbox" name="only_me" className="accent-primary" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
              {ONLY_ME}
            </label>
            <p className="text-small text-muted-foreground">{ONLY_ME_WHY}</p>
            {/* Grey until the owner's word is ticked, which it says beside it (and to a screen reader, as its description). */}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" variant="solid" disabled={!onlyMe || busy} aria-describedby={onlyMe ? undefined : onlyMeFirst}>Turn on</Button>
              {!onlyMe && <p id={onlyMeFirst} className="text-small text-muted-foreground">{ONLY_ME_FIRST}</p>}
            </div>
          </form>
        )}
        {on && writable && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void act(() => v2.turnOffClaudeLogin(), true)}>Turn off</Button>
            {canSignOut(view) && !confirming && <Button size="sm" disabled={busy} onClick={() => { setConfirming(true); setProblem(null); }}>Sign out</Button>}
          </div>
        )}
        {writable && confirming && canSignOut(view) && (
          <div className="flex flex-wrap items-center gap-3 border bg-card p-3">
            <p className="min-w-0 flex-1 text-body">{SIGN_OUT_ASK}</p>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void signOut()}>Sign out</Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
          </div>
        )}
        {!on && signedOut && <p className="text-body" role="status">{signedOut}</p>}
        {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      </div>
    </li>
  );
}
