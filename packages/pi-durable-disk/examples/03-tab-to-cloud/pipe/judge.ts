// The dark-content judge: one typed question about an answer before the tab shows it. A model the server reaches with
// its own credential answers with a strict JSON schema; the verdict is "refuse" when the answer is dark or makes a false,
// damaging claim about a real person, and also when the judge times out, fails, or says something that does not parse.
// An answer nobody judged is never shown.
import { readFileSync } from "node:fs";

/**
 * The rubric and schema, stated once for every screen and the training set: `judge-rubric.json` is the episode's shared
 * grader (rubric_template with `{topic}`, and a strict schema whose property order matters: `false_claim_person` comes
 * before `false_claim`, so the grader names a real person before it may flag a claim about one).
 */
export const RUBRIC = JSON.parse(readFileSync(new URL("./judge-rubric.json", import.meta.url), "utf8")) as {
  rubric_template: string;
  schema: { required: string[]; properties: Record<string, { type: string; minimum?: number; maximum?: number }> };
};

/** The grade matches the schema exactly: the same keys, each of its type and range. */
function fitsSchema(grade: unknown): grade is Record<string, unknown> {
  if (grade === null || typeof grade !== "object" || Array.isArray(grade)) return false;
  const props = RUBRIC.schema.properties;
  const keys = Object.keys(grade);
  if (keys.length !== Object.keys(props).length || !keys.every((k) => k in props)) return false;
  return Object.entries(props).every(([k, p]) => {
    const v = (grade as Record<string, unknown>)[k];
    if (p.type === "boolean") return typeof v === "boolean";
    if (p.type === "string") return typeof v === "string";
    if (p.type === "integer") return Number.isInteger(v) && (p.minimum === undefined || (v as number) >= p.minimum) && (p.maximum === undefined || (v as number) <= p.maximum);
    return false;
  });
}

/** Longest answer the judge reads; a longer one is refused by the route, not truncated. */
export const JUDGE_ANSWER_MAX = 8_000;

export interface JudgeOptions {
  /** OpenAI-compatible base URL (`.../v1`). */
  readonly baseUrl: string;
  readonly model: string;
  /** The endpoint's credential, sent as a bearer token; none for an endpoint that takes none (a local broker). */
  readonly apiKey?: string;
  /** Give up and refuse after this long. Default 4000 ms. */
  readonly timeoutMs?: number;
  /** Test seam. */
  readonly fetch?: typeof fetch;
}

export interface Verdict {
  readonly verdict: "show" | "refuse";
  /** The judge's answer; null when there was none (timeout, error, unparsable). */
  readonly dark: boolean | null;
  /** A false, damaging claim about a real person stated as fact; null when there was no answer. */
  readonly false_claim: boolean | null;
  readonly quote: string;
  readonly ms: number;
  readonly model: string;
  readonly error?: string;
}

/** Judge one answer. Never throws: every failure is a refusal with the reason in `error`. */
export async function judgeAnswer(input: { prompt: string; answer: string; topic?: string }, options: JudgeOptions): Promise<Verdict> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const refuse = (error: string): Verdict => ({ verdict: "refuse", dark: null, false_claim: null, quote: "", ms: ms(), model: options.model, error });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
  try {
    const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: RUBRIC.rubric_template.replaceAll("{topic}", input.topic?.trim() || "the topic it was given") },
          { role: "user", content: `USER ASKED:\n${input.prompt}\n\nANSWER:\n${input.answer}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: "grade", strict: true, schema: RUBRIC.schema } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return refuse(`judge endpoint answered ${response.status}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    let grade: unknown;
    try {
      grade = JSON.parse(content ?? "");
    } catch {
      return refuse("judge answer did not parse");
    }
    // The whole shape, as the schema says: an endpoint that ignored the strict schema is refused.
    if (!fitsSchema(grade)) return refuse("judge answer did not match the schema");
    const dark = grade.dark as boolean;
    const falseClaim = grade.false_claim as boolean;
    const quote = dark ? (grade.dark_quote as string) : falseClaim ? (grade.false_claim_quote as string) : "";
    return { verdict: dark || falseClaim ? "refuse" : "show", dark, false_claim: falseClaim, quote, ms: ms(), model: options.model };
  } catch (error) {
    return refuse(controller.signal.aborted ? "judge timed out" : `judge call failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
