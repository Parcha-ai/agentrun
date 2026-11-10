import { ChevronRight, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, fieldBoxClass, Input } from "@/components/ui/field";
import type { AuthMode } from "@/lib/auth";
import type { ImportOffer } from "@/lib/client";
import { cn } from "@/lib/utils";

export type SignInProps = {
  mode: Exclude<AuthMode, "signed_in">;
  /** The setup code from the link the server printed (`#code=`), when setup needs one. */
  code?: string | null;
  /** Whether setup takes the server's printed code (its session read's `setup_code`): the field shows with no link too. */
  codeNeeded?: boolean;
  /** Signs in, or sets the first password (`importSessions`: setup's box, ticked); resolves with the refusal to show, or
   *  null. */
  onSubmit?: (password: string, code?: string, importSessions?: boolean) => Promise<string | null>;
  problem?: string | null;
  /** In setup, a server on this machine's offer to import its sessions (`GET /v2/setup/import`): the box shows with it,
   *  counting, counted, or its count unknown. */
  offer?: ImportOffer | null;
};

// The password field for each mode: its label, and the autocomplete token a password manager reads.
const FIELD = {
  setup: { label: "New password", autocomplete: "new-password" },
  sign_in: { label: "Password", autocomplete: "current-password" },
} as const;

const COPY = {
  sign_in: { title: "Sign in", body: "Sign in to make agents, start runs and follow them on this server." },
  setup: { title: "Start building", body: "This is the server's first visit: set the owner's password. You sign in with it from now on." },
  token_link: { title: "Open the server's link", body: "This server has no accounts. Open the link it printed when it started: it signs this browser in once, and the token leaves the address." },
} as const;

/** The hosted console's sign-in card, over AgentRun Server's own: the owner's password (or its first setting), with the
 *  server's HttpOnly session cookie as the result. Nothing is kept in the page. */
export function SignIn({ mode, code = null, codeNeeded = false, onSubmit, problem: initialProblem = null, offer = null }: SignInProps) {
  const [password, setPassword] = useState("");
  // Never ticked for the owner: their own click asks for the import.
  const [importSessions, setImportSessions] = useState(false);
  const [again, setAgain] = useState("");
  const [setupCode, setSetupCode] = useState(code ?? "");
  // A setup link opened in this same tab after the page loaded: its code fills the field, the passwords typed stay.
  useEffect(() => { if (code !== null) setSetupCode(code); }, [code]);
  const [problem, setProblem] = useState<string | null>(initialProblem);
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";
  // A count of none has nothing to offer; counting, or a count unknown, still does.
  const offered = setup && offer !== null && !("sessions" in offer && offer.sessions === 0);
  // The server takes a code at setup (its session read says so, or the link carried one): never sent without it.
  const asksCode = setup && (codeNeeded || code !== null);
  const ready = mode !== "token_link" && password.length > 0 && (!setup || (password === again && password.length >= 12)) && (!asksCode || setupCode.trim() !== "");
  const submit = async () => {
    if (!ready || !onSubmit) return;
    setBusy(true);
    // The code as the log printed it: base64url, so whitespace around a paste is none of it.
    const p = await onSubmit(password, asksCode && setupCode.trim() ? setupCode.trim() : undefined, setup && offered && importSessions);
    setBusy(false); setProblem(p);
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="w-full max-w-[440px] border bg-card p-8">
        <span className="flex items-center gap-1.5 font-mono text-figure font-semibold" aria-label="AgentRun"><ChevronRight className="size-5 text-primary-text" aria-hidden /><span>agent<span className="text-primary-text">.run()</span></span></span>
        <h1 className="mb-3 mt-8 text-2xl">{COPY[mode].title}</h1>
        <p className="mb-6 text-prose leading-relaxed text-muted-foreground">{COPY[mode].body}</p>
        {mode !== "token_link" && (
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {asksCode && (
              <Field label="Setup code" id="setup-code" hint="On Render: paste the server's AGENTRUN_TOKEN from the service's Environment tab. Elsewhere: paste the setup code the server printed in its log, or open the link it prints.">
                <Input name="setup-code" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} className="text-lead" />
              </Field>
            )}
            <Field label={FIELD[mode].label} hint={setup ? "12 characters or more." : undefined}>
              <span className={cn("flex items-center gap-3 px-3", fieldBoxClass)}>
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <Input bare type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={FIELD[mode].autocomplete} autoFocus
                  aria-label={FIELD[mode].label} className="h-control-md flex-1 text-lead" />
              </span>
            </Field>
            {setup && (
              <Field label="Again" hint={again && again !== password ? "The two passwords differ." : undefined}>
                <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="Password again" className="text-lead" />
              </Field>
            )}
            {offered && (
              <label className="flex items-start gap-3 text-lead">
                <input type="checkbox" name="import" checked={importSessions} onChange={(e) => setImportSessions(e.target.checked)} className="mt-1 size-4 accent-primary" />
                <span>
                  <span className="block">Import this machine's Claude Code, Codex and pi sessions</span>
                  <span className="mt-1 block text-small text-muted-foreground" aria-live="polite">{offerNote(offer)}</span>
                </span>
              </label>
            )}
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
const EACH = "Each project becomes an agent, each session a run you can read.";
/** The box's note: the counts as they stand. */
function offerNote(offer: ImportOffer): string {
  if ("counting" in offer) return `Counting sessions… ${EACH}`;
  if (offer.sessions === null || offer.projects === null) return `The count isn't known. ${EACH}`;
  return `${count(offer.sessions, "session")} in ${count(offer.projects, "project")}. ${EACH}`;
}
