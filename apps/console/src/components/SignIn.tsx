import { ChevronRight, KeyRound } from "lucide-react";
import { useState } from "react";
import type { AuthMode } from "@/lib/auth";
import { cn } from "@/lib/utils";

export type SignInProps = {
  mode: Exclude<AuthMode, "signed_in">;
  /** The setup code from the link the server printed (`#code=`), when setup needs one. */
  code?: string | null;
  /** Signs in, or sets the first password; resolves with the refusal to show, or null. */
  onSubmit?: (password: string, code?: string) => Promise<string | null>;
  problem?: string | null;
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
export function SignIn({ mode, code = null, onSubmit, problem: initialProblem = null }: SignInProps) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [setupCode, setSetupCode] = useState(code ?? "");
  const [problem, setProblem] = useState<string | null>(initialProblem);
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";
  const ready = mode !== "token_link" && password.length > 0 && (!setup || (password === again && password.length >= 12));
  const submit = async () => {
    if (!ready || !onSubmit) return;
    setBusy(true);
    const p = await onSubmit(password, setup && setupCode ? setupCode : undefined);
    setBusy(false); setProblem(p);
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-[#080808] p-6 text-[#f5f5f5]">
      <div className="w-full max-w-[440px] border border-[#333] p-8">
        <span className="flex items-center gap-1.5 font-mono text-[22px] font-semibold" aria-label="AgentRun"><ChevronRight className="size-5 text-primary" aria-hidden /><span>agent<span className="text-primary">.run()</span></span></span>
        <h1 className="mb-3 mt-8 text-2xl">{COPY[mode].title}</h1>
        <p className="mb-6 text-[15px] leading-relaxed text-[#aaa]">{COPY[mode].body}</p>
        {mode !== "token_link" && (
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {setup && code !== null && (
              <Field label="Setup code" note="From the link or the server's log.">
                <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" spellCheck={false} className={input} />
              </Field>
            )}
            <Field label={FIELD[mode].label} note={setup ? "12 characters or more." : undefined}>
              <span className="flex items-center gap-3 border border-[#444] bg-black px-3 focus-within:border-[#f5f5f5]">
                <KeyRound className="size-4 text-[#888]" aria-hidden />
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={FIELD[mode].autocomplete} autoFocus
                  aria-label={FIELD[mode].label} className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[14px] outline-none" />
              </span>
            </Field>
            {setup && (
              <Field label="Again" note={again && again !== password ? "The two passwords differ." : undefined}>
                <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="Password again" className={input} />
              </Field>
            )}
            <button type="submit" disabled={!ready || busy}
              className={cn("caps h-10 w-full border text-[13px]", ready && !busy ? "border-primary bg-primary text-black hover:bg-primary/90" : "border-[#555] bg-[#555] text-[#999]")}>
              {busy ? "Signing in" : setup ? "Set password and continue" : "Continue"}
            </button>
            {problem && <p className="font-mono text-[13px] text-destructive-text" role="alert">{problem}</p>}
            {!setup && (
              <p className="text-[12px] leading-relaxed text-[#888]">
                Forgot it? Where the server runs, <code className="font-mono text-[#ccc]">agentrun-serve reset-password --data DIR</code> clears it
                (in the image: <code className="font-mono text-[#ccc]">reset-password --data /data</code>); the next visit here sets a new one.
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

const input = "h-10 w-full border border-[#444] bg-black px-3 font-mono text-[14px] outline-none focus:border-[#f5f5f5]";

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="caps mb-2 block text-[12px] font-semibold">{label}</span>
      {children}
      {note && <span className="mt-1.5 block text-[12px] text-[#888]">{note}</span>}
    </label>
  );
}
