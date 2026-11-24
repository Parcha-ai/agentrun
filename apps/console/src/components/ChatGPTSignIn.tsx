import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Input } from "@/components/ui/field";
import { harnessLabel } from "@/lib/agentForm";
import { chatGPTView, EXPIRED, MANAGE_USAGE_URL, NOT_REVOKED, PASTE_STEP, PLAN_IS_YOURS, PLAN_RUNS, signedInAs, SIGNED_OUT } from "@/lib/chatgpt";
import { type Client, ClientError } from "@/lib/client";
import { clock } from "@/lib/format";
import { type HarnessInfo, modelLabel } from "@/lib/models";
import { httpHref } from "@/lib/safeUrl";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ChatGPTView } from "@/lib/v2";

/** How often a waiting sign-in is read, while the page is in view: on the machine the server runs on, the browser's return
 *  finishes it with no paste, and the page should say so within a moment. */
const POLL_MS = 2_000;

const words = (e: unknown): string => (e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e));

/** "Manage usage" (or `children`), to ChatGPT's settings in a new tab. */
export const ManageUsage = ({ children = "Manage usage" }: { children?: ReactNode }) => <a href={MANAGE_USAGE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{children}</a>;

/** OpenAI's disclosure, word for word, then ours: shown at the first sign-in and on the Settings row. */
export function PlanDisclosure() {
  return (
    <div className="space-y-1 text-body text-muted-foreground">
      <p>Eligible usage in this app uses your ChatGPT plan. <ManageUsage /> in your ChatGPT settings.</p>
      <p>{PLAN_IS_YOURS}</p>
    </div>
  );
}

/** Sign in with ChatGPT, over /v2/settings/chatgpt. Signed out or expired: "Continue with ChatGPT" (with `beside` next to
 *  it), which starts the sign-in and opens OpenAI's page in a new tab. Waiting: the paste step (the address the tab ended
 *  on, which finishes it on a server elsewhere), until when it waits (the server's view says it, so a reload shows it
 *  too), the server's `hint` once a read carries one (past the first minute: a workspace admin's setting OpenAI refuses
 *  on its own page, with no way back), and Start again; on the machine the server runs on, the browser's return finishes it by itself, which a read
 *  every POLL_MS sees while the page is in view. While a pasted address finishes (the server reads the plan's models
 *  first, a few seconds), reads still say pending and the page says it is finishing; a paste the server refuses because
 *  the browser's return finished the sign-in first shows the sign-in, not the refusal. Signed in: who, on which plan, and
 *  OpenAI's words on usage. A refusal is said in the server's words. `onView`: each state it moves to. The pasted address
 *  is never kept in the page: the field is uncontrolled and cleared once the sign-in finishes. */
export function ChatGPTSignIn({ v2, view, onView, writable = true, whyNot = "sign_in", beside }: { v2: Client; view: ChatGPTView; onView?: (v: ChatGPTView) => void; writable?: boolean; whyNot?: SecretsWhyNot; beside?: ReactNode }) {
  const [v, setV] = useState(view);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [typed, setTyped] = useState(false);
  // A waiting sign-in's newest `hint` from a read or a start (why it may be stuck; null, none), over the view it opened on
  // (undefined, nothing newer).
  const [hint, setHint] = useState<string | null | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  // Only the newest read or write lands: a read sent before a finish never undoes it.
  const asked = useRef(0);
  useEffect(() => { setV(view); }, [view]);
  const set = (next: ChatGPTView) => { setV(next); onView?.(next); };

  const pending = v.state === "pending";
  useEffect(() => {
    if (!pending) return;
    // One read at a time: a tick while one is out waits for the next, so a read slower than the poll still lands.
    let reading = false;
    const read = () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      const n = ++asked.current;
      v2.chatGPT().then((body) => {
        const next = chatGPTView(body);
        // The sign-in ended: a paste's refusal from while it waited is stale, and the server's view says how it ended.
        if (n === asked.current && next && next.state !== "pending") { setProblem(null); set(next); }
        // Still waiting: the server's word on why it may be stuck (OpenAI's page can refuse with no way back here).
        else if (n === asked.current && next?.state === "pending") setHint(next.hint ?? null);
      }, () => {}).finally(() => { reading = false; });
    };
    const timer = setInterval(read, POLL_MS);
    const shown = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", shown);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [v2, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setProblem(null); setBusy(true);
    // The tab opens on the press (a tab opened after an answer is a pop-up a browser may block), then goes to OpenAI's page
    // with no way back to this one.
    const tab = window.open("", "_blank");
    asked.current++;
    try {
      const s = await v2.startChatGPT();
      if (tab) { tab.opener = null; tab.location.href = s.authorize_url; }
      setHint(null);
      set({ state: "pending", authorize_url: s.authorize_url, expires_at: s.expires_at });
    } catch (e) {
      tab?.close();
      setProblem(words(e));
    } finally { setBusy(false); }
  };
  const finish = async (e: FormEvent) => {
    e.preventDefault();
    const address = field.current?.value.trim();
    if (!address) return;
    setProblem(null); setBusy(true); setFinishing(true);
    asked.current++;
    const done = (next: ChatGPTView) => {
      if (field.current) field.current.value = "";
      setTyped(false);
      set(next);
    };
    try {
      done(await v2.finishChatGPT(address));
    } catch (err) {
      // The browser's return can finish the sign-in on this machine before the paste lands, which the server then refuses
      // as no sign-in waiting: the state says what happened.
      const now = await v2.chatGPT().then(chatGPTView, () => null);
      if (now?.state === "signed_in") done(now);
      else setProblem(words(err));
    } finally { setBusy(false); setFinishing(false); }
  };

  // A refusal here first; else why the server's last sign-in ended unsigned (its view's `problem`, never on a waiting
  // one): OpenAI's tab says it completed before the server exchanges the code, so this is the only word of a failure after it.
  const said = problem ?? v.problem;
  const alert = said && <p className="font-mono text-small text-destructive-text" role="alert">{said}</p>;
  if (v.state === "signed_in") return (
    <div className="space-y-2">
      <p className="text-body font-semibold">{signedInAs(v)}</p>
      <PlanDisclosure />
      {alert}
    </div>
  );
  if (!writable) return <p className="text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>;
  if (!pending) return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="solid" disabled={busy} onClick={() => void start()}>Continue with ChatGPT</Button>
        {beside}
      </div>
      {alert}
    </div>
  );
  const link = httpHref(v.authorize_url);
  const expires = v.expires_at;
  const stuck = hint === undefined ? v.hint : hint;
  return (
    <form onSubmit={(e) => void finish(e)} autoComplete="off" className="space-y-3 border bg-card p-4" aria-label="Finish signing in with ChatGPT">
      <p className="text-body">{PASTE_STEP}</p>
      <p className="font-mono text-small text-muted-foreground">
        {link && <><a href={link} target="_blank" rel="noopener noreferrer" className="text-primary-text underline underline-offset-2">Open the sign-in page</a> (a new tab)</>}
        {link && expires && " · "}
        {expires && `Waits until ${clock(expires)}`}
      </p>
      <label className="block">
        <span className="caps mb-2 block text-small font-semibold">The sign-in tab's address</span>
        <Input ref={field} name="redirect_url" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" placeholder="127.0.0.1:1455/auth/callback?code=…"
          onInput={() => setTyped(!!field.current?.value.trim())} />
      </label>
      {stuck && <p className="text-small text-warning-text" role="status">{stuck}</p>}
      {alert}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy}>{finishing ? "Finishing…" : "Finish sign-in"}</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void start()}>Start again</Button>
      </div>
    </form>
  );
}

const STATE: Record<ChatGPTView["state"], { tone: ChipTone; words: string }> = {
  signed_in: { tone: "success", words: "signed in" },
  pending: { tone: "plain", words: "waiting" },
  expired: { tone: "warning", words: "expired" },
  signed_out: { tone: "plain", words: "not signed in" },
};

/** Settings → Model keys' "ChatGPT plan" row: its state, who and which plan, the plan's models and OpenAI's words on
 *  usage; Sign out asks first and then says what is left to do in ChatGPT; expired, it says so and offers the sign-in
 *  again. Nothing on a server without the sign-in (its GET is not one). `onChange`: after a sign-in or a sign-out, which
 *  change the server's models. */
export function ChatGPTRow({ v2, writable, whyNot, onChange }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot; onChange?: () => void }) {
  const [view, setView] = useState<ChatGPTView | null>(null);
  const [confirming, setConfirming] = useState(false);
  // `settings`: the note says to act in ChatGPT's settings, which it links beside its words.
  const [note, setNote] = useState<{ words: string; settings?: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    v2.chatGPT().then((body) => { if (live) setView(chatGPTView(body)); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [v2]);
  if (!view) return null;
  const signOut = async () => {
    setProblem(null);
    let out: Awaited<ReturnType<Client["signOutChatGPT"]>>;
    try { out = await v2.signOutChatGPT(); } catch (e) { setProblem(words(e)); return; }
    setConfirming(false);
    setView({ state: "signed_out" });
    // Signed out here either way. OpenAI didn't confirm the revocation: the server's words, and ChatGPT's settings beside
    // them, where AgentRun is removed by hand. A server whose sign-out has no answer (204) says nothing of it.
    setNote(typeof out === "object" && out?.revoked === false ? { words: out.message || NOT_REVOKED, settings: true } : { words: SIGNED_OUT });
    onChange?.();
  };
  const moved = (next: ChatGPTView) => {
    setView(next);
    if (next.state !== "pending") setNote(null);
    if (next.state === "signed_in") onChange?.();
  };
  const state = STATE[view.state];
  return (
    <li aria-label="ChatGPT plan" className="border-b p-4 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-prose font-semibold">ChatGPT plan</span>
        <Chip tone={state.tone}>{state.words}</Chip>
      </p>
      <p className="mt-1.5 font-mono text-small text-muted-foreground">{PLAN_RUNS}</p>
      <div className="mt-3 space-y-3">
        {view.state === "expired" && <p className="text-body text-warning-text">{EXPIRED}</p>}
        {view.state === "signed_in" && view.models?.length ? <p className="font-mono text-small text-muted-foreground">Models: {view.models.join(" · ")}</p> : null}
        <ChatGPTSignIn v2={v2} view={view} onView={moved} writable={writable} whyNot={whyNot} />
        {view.state === "signed_in" && writable && !confirming && <Button size="sm" onClick={() => { setConfirming(true); setProblem(null); }}>Sign out</Button>}
        {confirming && (
          <div className="flex flex-wrap items-center gap-3 border bg-card p-3">
            <p className="min-w-0 flex-1 text-body">Sign out of ChatGPT on this server? Codex and pi agents then need a key to run here.</p>
            <Button size="sm" variant="destructive" onClick={() => void signOut()}>Sign out</Button>
            <Button size="sm" onClick={() => setConfirming(false)}>Keep</Button>
          </div>
        )}
        {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
        {note && <p className="text-body" role="status">{note.words}{note.settings && <> <ManageUsage>ChatGPT settings</ManageUsage></>}</p>}
      </div>
    </li>
  );
}

/** A harness's state as the server's `needs` says it: one the ChatGPT sign-in would run, one a key would, one that runs
 *  here, or one that doesn't for another reason. Never read off its words. */
function harnessChip(h: HarnessInfo): { tone: ChipTone; text: string } {
  if (h.needs?.includes("chatgpt")) return { tone: "warning", text: "runs after Continue with ChatGPT" };
  if (h.needs?.includes("key")) return { tone: "warning", text: "needs a key" };
  return h.available ? { tone: "success", text: "ready" } : { tone: "warning", text: "not here" };
}

/** What runs here, harness by harness, as the capabilities say: ready (on its default model), or what it needs, in the
 *  server's words. Nothing when the server lists no harness. */
export function WhatRunsHere({ harnesses, routePrefix }: { harnesses: readonly HarnessInfo[]; routePrefix?: string | null }) {
  if (!harnesses.length) return null;
  return (
    <section aria-label="What runs here">
      <h2 className="caps mb-2 text-small font-semibold text-muted-foreground">What runs here</h2>
      <ul className="border">
        {harnesses.map((h) => {
          const chip = harnessChip(h);
          return (
            <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5 last:border-b-0">
              <span className="font-mono text-body font-semibold">{harnessLabel(h.id)}</span>
              <Chip tone={chip.tone}>{chip.text}</Chip>
              {h.available && !h.needs?.length
                ? h.default_model && <span className="font-mono text-small text-muted-foreground">{modelLabel(h.default_model, routePrefix).text}</span>
                : h.reason && <span className="text-small text-muted-foreground">{h.reason}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
