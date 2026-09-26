
export type SystemOneQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export type SystemOneAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export type SystemOneResult = {
  answers: Record<string, SystemOneAnswer>;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  latency_ms: number;
  request_sha256: string;
};

export const SYSTEM_ONE_LIMITS = { maxChoiceOptions: 240, minScoreLevels: 2, maxScoreLevels: 10 } as const;

export const SYSTEM_ONE_DEFAULT_MODEL = "jev-latest";

const CRITERIA = "criteria";

export type CompiledQuestions = Record<string, SystemOneQuestion>;

export function compileQuestions(schema: Record<string, unknown>, definitions: Record<string, unknown> = {}): { ok: true; questions: CompiledQuestions } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  // Question IDs and choice labels are arbitrary JSON keys, including "__proto__".
  // Null-prototype construction prevents setters; object spread returns ordinary public records.
  const questions: CompiledQuestions = Object.create(null);
  const resolve = (spec: any): any => {
    const seen = new Set<unknown>();
    while (spec && typeof spec.$ref === "string") {
      if (seen.has(spec)) return undefined;
      seen.add(spec);
      const m = /^#\/definitions\/(.+)$/.exec(spec.$ref);
      const inline = schema.definitions as Record<string, unknown> | undefined;
      spec = m ? (inline && Object.hasOwn(inline, m[1]) ? inline[m[1]] : Object.hasOwn(definitions, m[1]) ? definitions[m[1]] : undefined) : undefined;
    }
    return spec;
  };
  const root = resolve(schema);
  const type = Array.isArray(root?.type) ? root.type[0] : root?.type;
  if (!root || (type !== "object" && !root.properties)) return { ok: false, errors: ["a question schema is a flat object schema"] };
  const properties = (root.properties || {}) as Record<string, any>;
  if (!Object.keys(properties).length) return { ok: false, errors: ["a question schema declares at least one property"] };
  for (const [id, rawSpec] of Object.entries(properties)) {
    const spec = resolve(rawSpec);
    const instructions = typeof spec?.description === "string" && spec.description.trim() ? spec.description.trim() : "";
    if (!instructions) { errors.push(`property "${id}": a question needs a description (its instructions)`); continue; }
    const types = (Array.isArray(spec.type) ? spec.type : [spec.type]).filter((t: unknown) => t !== "null");
    const criteria = spec[CRITERIA];
    if (Array.isArray(spec.enum) && spec.enum.length) {
      if (types.some((t: string) => t !== "string") || spec.enum.some((v: unknown) => typeof v !== "string")) { errors.push(`property "${id}": a choice is a string enum`); continue; }
      if (spec.enum.length > SYSTEM_ONE_LIMITS.maxChoiceOptions) { errors.push(`property "${id}": a choice takes at most ${SYSTEM_ONE_LIMITS.maxChoiceOptions} options (${spec.enum.length} given)`); continue; }
      const map: Record<string, string | null> = Object.create(null);
      for (const option of spec.enum as string[]) {
        const text = criteria && typeof criteria === "object" && !Array.isArray(criteria) ? criteria[option] : undefined;
        map[option] = typeof text === "string" && text.trim() ? text.trim() : null;
      }
      if (criteria && typeof criteria === "object" && !Array.isArray(criteria)) {
        const unknown = Object.keys(criteria).filter((k) => !(spec.enum as string[]).includes(k));
        if (unknown.length) errors.push(`property "${id}": criteria name options the enum does not have: ${unknown.join(", ")}`);
      }
      questions[id] = { type: "choice", instructions, criteria: { ...map } };
      continue;
    }
    if (types.length === 1 && types[0] === "boolean") {
      const c = criteria && typeof criteria === "object" && !Array.isArray(criteria) ? criteria : undefined;
      questions[id] = { type: "noul", instructions, ...(c ? { criteria: { ...(typeof c.true === "string" ? { true: c.true } : {}), ...(typeof c.false === "string" ? { false: c.false } : {}) } } : {}) };
      continue;
    }
    if (types.length === 1 && types[0] === "integer") {
      const levels = Array.isArray(criteria) ? criteria : null;
      if (!levels || levels.some((l) => typeof l !== "string" || !l.trim())) { errors.push(`property "${id}": a score is an integer with criteria: [level descriptions] (${SYSTEM_ONE_LIMITS.minScoreLevels}..${SYSTEM_ONE_LIMITS.maxScoreLevels} levels)`); continue; }
      if (levels.length < SYSTEM_ONE_LIMITS.minScoreLevels || levels.length > SYSTEM_ONE_LIMITS.maxScoreLevels) { errors.push(`property "${id}": a score takes ${SYSTEM_ONE_LIMITS.minScoreLevels}..${SYSTEM_ONE_LIMITS.maxScoreLevels} levels (${levels.length} given)`); continue; }
      if (spec.minimum !== undefined && spec.minimum !== 0) errors.push(`property "${id}": a score's minimum is 0 (level 0)`);
      if (spec.maximum !== undefined && spec.maximum !== levels.length - 1) errors.push(`property "${id}": a score's maximum is its last level index (${levels.length - 1})`);
      questions[id] = { type: "score", instructions, criteria: levels as string[] };
      continue;
    }
    errors.push(`property "${id}": not a question — a question is a string enum (choice), a boolean (noul), or an integer with level criteria (score); prose and lists belong to a decide node`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, questions: { ...questions } };
}

export function answersToValue(answers: Record<string, SystemOneAnswer>, questions: CompiledQuestions): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a) throw new Error(`System One returned no answer for question "${id}"`);
    if (q.type === "choice" && a.type === "choice") out[id] = a.choice;
    else if (q.type === "noul" && a.type === "noul") out[id] = a.noul >= 0.5;
    else if (q.type === "score" && a.type === "score") out[id] = Math.max(0, Math.round(a.score));
    else throw new Error(`System One answered question "${id}" with type "${a.type}", expected ${q.type}`);
  }
  return { ...out };
}

export function answerConfidence(answer: SystemOneAnswer): number {
  if (!answer || typeof answer !== "object") throw new SystemOneError("System One answer missing for a question that was asked", null);
  if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
  return typeof answer.confidence === "number" ? answer.confidence : 0;
}

export type AnswersSidecar = { answers: Record<string, SystemOneAnswer>; confidence: Record<string, number>; weakest: string | null; min_confidence: number | null };

export function answersSidecar(answers: Record<string, SystemOneAnswer>): AnswersSidecar {
  const confidence: Record<string, number> = Object.create(null);
  let weakest: { question: string; confidence: number } | null = null;
  for (const [id, a] of Object.entries(answers)) {
    const c = +answerConfidence(a).toFixed(4);
    confidence[id] = c;
    if (!weakest || c < weakest.confidence) weakest = { question: id, confidence: c };
  }
  return { answers, confidence: { ...confidence }, weakest: weakest?.question ?? null, min_confidence: weakest?.confidence ?? null };
}

export function synthesizeAnswers(questions: Record<string, SystemOneQuestion>): Record<string, SystemOneAnswer> {
  const out: Record<string, SystemOneAnswer> = Object.create(null);
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      out[id] = { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((o) => [o, 1 / options.length])), confidence: 0 };
    } else if (q.type === "noul") out[id] = { type: "noul", noul: 0.5 };
    else out[id] = { type: "score", score: (q.criteria.length - 1) / 2, legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), 1 / q.criteria.length])), confidence: 0 };
  }
  return { ...out };
}

export type SystemOneRetryClass = "http_429" | "http_5xx" | "connection" | "timeout";

const responseReasons = ["answers_shape", "answer_keys", "answer_shape", "answer_type", "noul_probability",
  "confidence", "probabilities", "probability_keys", "probability_mass", "score_legend", "score_consistency", "choice_option", "score_range"] as const;
export type SystemOneResponseReason = typeof responseReasons[number];
export function isSystemOneResponseReason(value: unknown): value is SystemOneResponseReason {
  return typeof value === "string" && (responseReasons as readonly string[]).includes(value);
}

export class SystemOneError extends Error {
  readonly responseReason?: SystemOneResponseReason;
  constructor(message: string, readonly retryClass: SystemOneRetryClass | null, readonly status?: number,
    responseReason?: SystemOneResponseReason) {
    super(message);
    this.name = "SystemOneError";
    if (isSystemOneResponseReason(responseReason)) this.responseReason = responseReason;
  }
}

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// System One rounds each probability to two places, so a distribution can sum to 0.99 or 1.01
// (three-way ties: 3 × 0.33). Drift up to 0.02 is accepted as reported, never rescaled: answers
// pass through validation unchanged. The 1e-9 absorbs binary float error in the sum itself.
const PROBABILITY_MASS_TOLERANCE = 0.02;

export function validateAnswers(questions: Record<string, SystemOneQuestion>, answers: unknown): asserts answers is Record<string, SystemOneAnswer> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new SystemOneError("System One response carries no answers", null, undefined, "answers_shape");
  const answerKeys = Object.keys(answers);
  if (answerKeys.length !== Object.keys(questions).length || answerKeys.some(id => !Object.hasOwn(questions, id))) throw new SystemOneError("System One answer keys do not match questions", null, undefined, "answer_keys");
  for (const [id, q] of Object.entries(questions)) {
    const a = (answers as Record<string, any>)[id];
    if (!a || typeof a !== "object") throw new SystemOneError("System One returned no answer for a question", null, undefined, "answer_shape");
    if (a.type !== q.type) throw new SystemOneError("System One answer type does not match its question", null, undefined, "answer_type");
    if (q.type === "noul") { if (!unit(a.noul)) throw new SystemOneError("System One answer: noul is not a probability", null, undefined, "noul_probability"); continue; }
    if (!unit(a.confidence)) throw new SystemOneError("System One answer: confidence is not in [0, 1]", null, undefined, "confidence");
    if (!a.probabilities || typeof a.probabilities !== "object" || !Object.values(a.probabilities).every(unit)) throw new SystemOneError("System One answer: probabilities are not a distribution", null, undefined, "probabilities");
    const expectedKeys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, index) => String(index));
    const probabilityKeys = Object.keys(a.probabilities);
    if (Array.isArray(a.probabilities) || probabilityKeys.length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(a.probabilities, key))) throw new SystemOneError("System One answer: probabilities must contain exactly the declared options", null, undefined, "probability_keys");
    const mass = Object.values(a.probabilities as Record<string, number>).reduce((sum, p) => sum + p, 0);
    if (Math.abs(mass - 1) > PROBABILITY_MASS_TOLERANCE + 1e-9) throw new SystemOneError("System One answer: probabilities must sum to 1", null, undefined, "probability_mass");
    if (q.type === "score") {
      if (!a.legend || typeof a.legend !== "object" || Array.isArray(a.legend) || Object.keys(a.legend).length !== expectedKeys.length || q.criteria.some((text, index) => a.legend[String(index)] !== text)) throw new SystemOneError("System One answer: legend must match the score criteria", null, undefined, "score_legend");
      const weighted = expectedKeys.reduce((sum, key) => sum + Number(key) * a.probabilities[key], 0);
      if (Math.abs(weighted - a.score) > 1e-5) throw new SystemOneError("System One answer: score must match its weighted distribution", null, undefined, "score_consistency");
    }
    if (q.type === "choice" && !(typeof a.choice === "string" && Object.prototype.hasOwnProperty.call(q.criteria, a.choice))) throw new SystemOneError("System One answer: choice is not an option", null, undefined, "choice_option");
    if (q.type === "score" && !(typeof a.score === "number" && Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1)) throw new SystemOneError("System One answer: score is outside its levels", null, undefined, "score_range");
  }
}
