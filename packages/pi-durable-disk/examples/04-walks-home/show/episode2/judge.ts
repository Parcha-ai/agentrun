// The stage's side of the dark-content judge: the tab asks it for each answer before showing it, and D2's judge needs the run's secret, which the page
// never holds. This forwards the tab's `{prompt, answer}` to the run's judge (POST /api/runs/<id>/judge) with the secret as a Bearer and gives back its status and JSON untouched.
// Nothing is logged: the answer text and the secret stay out of every log. It fails closed: when the stage is not the explicit rehearsal and there is no run
// (or the judge cannot be reached), the answer is `refuse`, never `show`. Only the rehearsal (`rehearsal: true`) has a scripted judge.
import type { LinkTarget } from "../link.ts";

export type JudgeResult = { status: number; body: unknown };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const MAX_FIELD = 16_000;
/** The rehearsal judge refuses any answer containing this exact string. */
export const REHEARSAL_REFUSE = "[[refuse]]";

/** The longest topic the tab sends (the manifest's own limit). */
const MAX_TOPIC = 80;

/**
 * The request body, or undefined when it is not `{prompt: string, answer: string}` within bounds. An optional `topic` (episode 2b: what the model is obsessed
 * with) is forwarded when it is a string of at most 80 characters; a missing, non-string or longer one is simply absent, never a refusal of the request.
 */
export function parseJudgeBody(text: string): { prompt: string; answer: string; topic?: string } | undefined {
  try {
    const o = JSON.parse(text) as { prompt?: unknown; answer?: unknown; topic?: unknown };
    if (typeof o.prompt !== "string" || typeof o.answer !== "string") return undefined;
    if (o.prompt.length > MAX_FIELD || o.answer.length > MAX_FIELD) return undefined;
    const topic = typeof o.topic === "string" && o.topic.trim() !== "" && o.topic.length <= MAX_TOPIC ? o.topic : undefined;
    return { prompt: o.prompt, answer: o.answer, ...(topic !== undefined ? { topic } : {}) };
  } catch {
    return undefined;
  }
}

const CLOSED = (status: number, error: string): JudgeResult => ({ status, body: { verdict: "refuse", error } });

export async function forwardJudge(target: LinkTarget | undefined, bodyText: string, options: { rehearsal?: boolean; fetchFn?: FetchLike } = {}): Promise<JudgeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const req = parseJudgeBody(bodyText);
  if (!req) return { status: 400, body: { verdict: "refuse", error: "the judge takes {prompt, answer}, both text" } };
  if (!target) {
    // A rehearsal has no judge: it shows everything except an answer that contains the exact string below, so the tab's refuse path can be tried from the stage.
    if (options.rehearsal === true) return { status: 200, body: { verdict: req.answer.includes(REHEARSAL_REFUSE) ? "refuse" : "show", scripted: true } };
    return CLOSED(503, "there is no judge for this run");
  }
  try {
    const res = await fetchFn(`${target.origin}/api/runs/${encodeURIComponent(target.run)}/judge`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.secret}`, "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({ error: "the judge did not answer in JSON" }))) as unknown;
    return { status: res.status, body };
  } catch {
    return CLOSED(502, "the judge could not be reached");
  }
}

/**
 * Whether this stage may use the scripted judge. Structural, from the environment alone: the scenario is exactly the episode 2 or the obsession rehearsal AND no link file
 * (a live run's) is configured at all, not merely readable now, and no upstream feed. A configured link whose file is missing or unreadable is a live take
 * whose run is not up: there the judge refuses.
 */
export function rehearsalJudge(env: Record<string, string | undefined>): boolean {
  return (env.SHOW_SCENARIO === "ep2" || env.SHOW_SCENARIO === "obsession") && env.SHOW_PIPE_LINK_FILE === undefined && env.SHOW_API === undefined;
}
