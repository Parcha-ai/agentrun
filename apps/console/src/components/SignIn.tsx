import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, fieldBoxClass, Input } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Wordmark } from "@/components/Wordmark";
import type { AuthMode } from "@/lib/auth";
import type { ImportOffer } from "@/lib/client";
import { ago } from "@/lib/needs";
import { cn } from "@/lib/utils";
import { setupCodePlaces } from "@/lib/auth";

export type SignInProps = {
  mode: Exclude<AuthMode, "signed_in">;
  /** The setup code from the link the server printed (`#code=`), when setup needs one. */
  code?: string | null;
  /** Whether setup takes the server's printed code (its session read's `setup_code`): the field shows with no link too. */
  codeNeeded?: boolean;
  /** Signs in, or sets the first password (`importProjects`: the projects ticked in setup's list, by id; none ticked,
   *  none); resolves with the refusal to show, or null. */
  onSubmit?: (password: string, code?: string, importProjects?: string[]) => Promise<string | null>;
  problem?: string | null;
  /** In setup, a server on this machine's offer to import its sessions (`GET /v2/setup/import`): the list shows with it,
   *  still looking, its projects to choose from, or that they couldn't be listed. */
  offer?: ImportOffer | null;
  /** Asks the server to print a new setup code to its log when the last one has run out (it keeps one still good):
   *  resolves with what to tell the person (where the line is and until when it works), and rejects with why it was
   *  refused. Never a code. */
  onNewCode?: () => Promise<string>;
  /** The address this page was opened at (the browser's, by default): it picks where the Setup code field says to look. */
  host?: string;
};

// The password field for each mode: its label, and the autocomplete token a password manager reads.
const FIELD = {
  setup: { label: "New password", autocomplete: "new-password" },
  sign_in: { label: "Password", autocomplete: "current-password" },
} as const;

const COPY = {
  sign_in: { title: "Sign in", body: "Sign in to make agents, start runs and follow them on this server." },
  setup: { title: "Start building", body: "This is the server's first visit: set the owner's password. You sign in with it from now on." },
  token_link: { title: "Open the server's link", body: "This server has no accounts. Open the link it printed when it started: it signs this browser in, and its code leaves the address." },
} as const;

/** The hosted console's sign-in card, over AgentRun Server's own: the owner's password (or its first setting), with the
 *  server's HttpOnly session cookie as the result. Nothing is kept in the page. */
export function SignIn({ mode, code = null, codeNeeded = false, onSubmit, onNewCode, problem: initialProblem = null, offer = null, host = typeof window === "undefined" ? "" : window.location.hostname }: SignInProps) {
  const [password, setPassword] = useState("");
  // The projects ticked, by id. Never ticked for the owner: their own clicks ask for the import, project by project.
  const [chosen, setChosen] = useState<string[]>([]);
  const [again, setAgain] = useState("");
  const [setupCode, setSetupCode] = useState(code ?? "");
  // A setup link opened in this same tab after the page loaded: its code fills the field, the passwords typed stay.
  useEffect(() => { if (code !== null) setSetupCode(code); }, [code]);
  const [problem, setProblem] = useState<string | null>(initialProblem);
  const [busy, setBusy] = useState(false);
  // What the server answered Get a new code, in words; and whether an ask is on its way.
  const [renewed, setRenewed] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const newCode = async () => {
    if (!onNewCode || renewing) return;
    setRenewing(true);
    // A refusal is a problem, said where the form's other problems are; an answer is a status under the button.
    try { setRenewed(await onNewCode()); setProblem(null); }
    catch (e) { setRenewed(null); setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setRenewing(false); }
  };
  const setup = mode === "setup";
  // A count of none has nothing to offer; one still looking, or one that failed, still says so.
  const offered = setup && offer !== null && !("sessions" in offer && offer.sessions === 0);
  // The server takes a code at setup (its session read says so, or the link carried one): never sent without it.
  const asksCode = setup && (codeNeeded || code !== null);
  const ready = mode !== "token_link" && password.length > 0 && (!setup || (password === again && password.length >= 12)) && (!asksCode || setupCode.trim() !== "");
  const submit = async () => {
    if (!ready || !onSubmit) return;
    setBusy(true);
    // The code as the log printed it: base64url, so whitespace around a paste is none of it.
    // Only projects the offer names now: one ticked in an earlier answer and gone from this one is not sent.
    const listed = setup && offer && "candidates" in offer ? (offer.candidates ?? []).map((c) => c.id) : [];
    const p = await onSubmit(password, asksCode && setupCode.trim() ? setupCode.trim() : undefined, chosen.filter((id) => listed.includes(id)));
    setBusy(false); setProblem(p);
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="w-full max-w-[440px] border bg-card p-8">
        <Wordmark />
        <h1 className="mb-3 mt-8 text-2xl font-semibold">{COPY[mode].title}</h1>
        <p className="mb-6 text-prose leading-relaxed text-muted-foreground">{COPY[mode].body}</p>
        {mode !== "token_link" && (
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {asksCode && (
              <Field label="Setup code" id="setup-code" hint={setupCodePlaces(host).map((place, i) => <span key={i} className={cn("block leading-relaxed", i > 0 && "mt-1.5")}>{place}</span>)}>
                <Input name="setup-code" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} className="text-lead" />
              </Field>
            )}
            {asksCode && onNewCode && (
              <div className="!mt-3">
                <Button type="button" size="sm" disabled={renewing} aria-busy={renewing || undefined} onClick={() => void newCode()}>Get a new code</Button>
                {renewed && <p className="mt-2 text-small leading-relaxed text-foreground" role="status">{renewed}</p>}
              </div>
            )}
            <Field label={FIELD[mode].label} note={setup ? "12 characters or more." : undefined}>
              <span className={cn(fieldBoxClass, "flex items-center gap-3 bg-card px-3")}>
                <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input bare type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={FIELD[mode].autocomplete} autoFocus
                  aria-label={FIELD[mode].label} className="h-10 min-w-0 flex-1 bg-transparent font-mono text-lead" />
              </span>
            </Field>
            {setup && (
              <Field label="Again" note={again && again !== password ? "The two passwords differ." : undefined}>
                <span className={cn(fieldBoxClass, "flex items-center gap-3 bg-card px-3")}>
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <Input bare type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="Password again"
                    className="h-10 min-w-0 flex-1 bg-transparent font-mono text-lead" />
                </span>
              </Field>
            )}
            {offered && <ImportChooser offer={offer} chosen={chosen} onChange={setChosen} />}
            <Button type="submit" variant="solid" disabled={!ready || busy} aria-busy={busy || undefined} className="w-full text-body">
              {busy ? "Signing in" : setup ? "Set password and continue" : "Continue"}
            </Button>
            {problem && <p className="font-mono text-body text-destructive-text" role="alert">{problem}</p>}
            {!setup && (
              <p className="text-small leading-relaxed text-muted-foreground">
                {/* The npx wrapper's command first (it takes reset-password, on its own store, ~/.agentrun), then the server's own. The
                    page is public: the data directory stays a placeholder. */}
                Forgot it? Where the server runs: <code className="font-mono text-foreground">npx @parcha/agentrun reset-password</code> (add{" "}
                <code className="font-mono text-foreground">--data DIR</code> if you started it with one). For a server you started yourself:{" "}
                <code className="font-mono text-foreground">agentrun-serve reset-password --data DIR</code> (in the image:{" "}
                <code className="font-mono text-foreground">--data /data</code>). The next visit here sets a new one.
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
// The tools an import reads, by their own names, in the order setup's summary names them; one not listed here by its id.
const SOURCE_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "pi", opencode: "OpenCode", copilot: "Copilot CLI" };
const sourceName = (source: string) => SOURCE_NAMES[source] ?? source;
/** "a", "a and b", "a, b and c". */
const inWords = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** The tools the projects' sessions came from, each once, in SOURCE_NAMES's order (any other after, by id). */
function sourcesOf(candidates: readonly { sources: readonly string[] }[]): string[] {
  const order = Object.keys(SOURCE_NAMES);
  const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  return [...new Set(candidates.flatMap((c) => c.sources))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(sourceName);
}
const IMPORT_LABEL = "Import sessions from this machine";

/** Setup's list of this machine's projects, each with a box, none ticked: the owner ticks the ones to import, and only
 *  those are. Each row says how many sessions the project holds, from which tools, and how long ago the latest ended. */
function ImportChooser({ offer, chosen, onChange }: { offer: ImportOffer; chosen: string[]; onChange: (ids: string[]) => void }) {
  if ("counting" in offer) {
    return (
      <Field group label={IMPORT_LABEL}>
        <p className="flex items-center gap-2 text-small text-muted-foreground" role="status"><Spinner />Looking for this machine's coding-agent sessions…</p>
      </Field>
    );
  }
  const candidates = offer.candidates ?? [];
  if (offer.sessions === null || offer.projects === null || !candidates.length) {
    return (
      <Field group label={IMPORT_LABEL}>
        <p className="text-small text-muted-foreground" role="status">This machine's sessions couldn't be listed, so there is nothing to choose here. To import them later, run agentrun-serve import with the server stopped.</p>
      </Field>
    );
  }
  const picked = candidates.filter((c) => chosen.includes(c.id));
  const all = picked.length === candidates.length;
  const now = Date.now();
  return (
    <Field group label={IMPORT_LABEL}
      aside={<Button type="button" size="xs" variant="ghost" onClick={() => onChange(all ? [] : candidates.map((c) => c.id))}>{all ? "Clear" : "Select all"}</Button>}
      note={`${count(offer.sessions, "session")} in ${count(offer.projects, "project")}, from ${inWords(sourcesOf(candidates))}. Tick the projects to import: each becomes an agent, each session a run you can read. Nothing is imported unless you tick it.${offer.projects > candidates.length ? ` The ${candidates.length.toLocaleString("en-US")} most recently active are listed.` : ""}`}
      hint={<span aria-live="polite">{picked.length ? `${count(picked.length, "project")}, ${count(picked.reduce((n, c) => n + c.sessions, 0), "session")} chosen.` : "None chosen: nothing will be imported."}</span>}>
      <div className="max-h-56 space-y-3 overflow-y-auto border p-3">
        {candidates.map((c) => (
          <Checkbox key={c.id} name="import" value={c.id} checked={chosen.includes(c.id)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id))}
            label={<span className="break-all font-mono">{c.name}</span>}
            note={<>
              <span className="block">{[count(c.sessions, "session"), sourcesOf([c]).join(", "), ...(c.last_active ? [`active ${ago(c.last_active, now)} ago`] : [])].join(" · ")}</span>
              <span className="block break-all font-mono">{c.path}</span>
            </>} />
        ))}
      </div>
    </Field>
  );
}

/** The card a first load shows while this server's session can't be read (`GET /v2/auth/session` failed): what failed,
 *  that it is tried again on its own, and Retry now. Never a sign-in or a setup: without the session's answer the page
 *  can't tell whether the server has its owner yet. `starting`: the address answered with a gateway's page (502, 503 or
 *  504, not the server's JSON), as a host's edge does while the server starts, redeploys or wakes. */
export function SessionUnread({ problem, starting = false, onRetry }: { problem: string; starting?: boolean; onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="w-full max-w-[440px] border bg-card p-8">
        <Wordmark />
        <h1 className="mb-3 mt-8 text-2xl font-semibold">{starting ? "This server is starting" : "Can't read this server's sign-in"}</h1>
        <p className="mb-4 text-prose leading-relaxed text-muted-foreground">{starting
          ? "Its address answers for it until it is up (a first start, a redeploy or a wake can take a minute or two). Trying again…"
          : "The page asked the server whether it has its owner yet, and got no answer it could read, so it can't show setup or sign-in. It asks again on its own."}</p>
        <p className="mb-6 break-words font-mono text-body text-destructive-text" role="alert">{problem}</p>
        <Button type="button" variant="solid" onClick={onRetry} className="w-full text-body">Retry now</Button>
      </div>
    </main>
  );
}
