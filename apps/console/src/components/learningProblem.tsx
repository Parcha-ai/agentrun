import { TriangleAlert } from "lucide-react";
import { ClientError } from "@/lib/client";

// A failed read or write, said for a person, in the shape of the console's problem card that is on its way (`problem`
// in lib/problem.ts and `ProblemCard` in components/Problem.tsx): the Learning tab imports both from here, so moving to
// those is its import line, and this file goes.

/** What failed, why in plain words, and what to do next; `said` is the server's own message and `code` its typed code
 *  and request id, kept small for a bug report. */
export type Problem = { title: string; why: string; next: string; said?: string; code?: string };

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const unreached = (e: unknown) => e instanceof TypeError && /fetch|network/i.test(e.message);

/** `what` names the thing read ("the notes"): "The notes could not be read." A write says its own title over it. */
export function problem(e: unknown, what: string): Problem {
  const title = `${sentence(what)} could not be read.`;
  if (unreached(e)) return { title, why: "Can't reach agentrun-serve.", next: "It may be restarting: try again in a moment." };
  if (!(e instanceof ClientError)) return { title, why: "Something went wrong in the console.", next: "Reload the page.", said: e instanceof Error ? e.message : String(e) };
  const said = e.fields?.[0]?.message ?? e.message, code = [e.code, e.requestId].filter(Boolean).join(" · ");
  const of = (why: string, next: string): Problem => ({ title, why, next, said, code });
  if (e.status === 401) return of("This browser is signed out.", "Reload the page to sign in again.");
  if (e.status === 403) return of("The server doesn't allow this here.", "Sign in as the server's owner, or open the console from the address the server printed.");
  if (e.status === 404) return of("This server doesn't have it.", "Check the address, or open the list it belongs to.");
  if (e.status === 412) return of("Someone, or a run, changed it first.", "Reload to see it as it is now.");
  if (e.status === 429) return of("Too many requests at once.", "Wait a few seconds, then try again.");
  if (e.retryable || e.status === 409 || e.status === 503) return of("The server is busy.", "Try again in a moment.");
  if (e.status >= 500) return of("The server hit a problem on its side.", "Try again. If it keeps failing, the server's log says why.");
  return of("The server turned the request down.", "Try again, and if it keeps happening, the server's words below say why.");
}

/** A failed read or write for a person: what failed, why and what to do next, then the server's own words and code,
 *  small. `onRetry` gives Try again. */
export function ProblemCard({ problem: p, onRetry, className = "m-8" }: { problem: Problem; onRetry?: () => void; className?: string }) {
  return (
    <section className={`flex gap-3 border bg-card px-4 py-4 md:px-5 ${className}`} role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
      <div className="min-w-0">
        <p className="text-[15px] font-semibold">{p.title}</p>
        <p className="mt-1 text-[14px] leading-relaxed">{p.why} {p.next}</p>
        {(p.said || p.code) && <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">{[p.said, p.code].filter(Boolean).join(" · ")}</p>}
        {onRetry && <div className="mt-3 flex flex-wrap gap-3"><button type="button" onClick={onRetry} className="caps border px-3 py-2 text-[12px] hover:bg-accent">Try again</button></div>}
      </div>
    </section>
  );
}
