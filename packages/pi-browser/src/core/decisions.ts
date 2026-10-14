export const WALL_CLASSES = Object.freeze([
  "captcha_or_bot_check", "login_wall", "paywall", "region_or_geo_block", "consent_interstitial",
  "error_or_not_found", "loading_or_js_required", "empty_or_template",
] as const);
export type WallClass = (typeof WALL_CLASSES)[number];

export type PageForJudgment = { url: string; status: number | null; contentType: string | null; text: string };

export type PageVerdict = {
  /** "content" files the page `ok`; a wall class files it `failed` with a typed way out. */
  wall: "content" | WallClass | "unjudged";
  /** Probability the page text carries instructions addressed to an AI reader; null when not asked. */
  injection: number | null;
  confidence: number | null;
  /** One line filed verbatim as the receipt's `page_guard` fact, so the decision re-derives with no model call. */
  guard?: string;
};

/** A non-GET request a `run` would send. Never a body, a header value or a field value. */
export type EffectRequest = {
  method: string;
  origin: string;
  path: string;
  queryKeys: string[];
  formFields: string[];
  pageTitle: string | null;
  trigger: string | null;
  task: string | null;
};

/** Probabilities, each in [0, 1]. */
export type EffectVerdict = { irreversible: number; telemetry: number; queryOnly: number };

export type Decisions = {
  classifyPage?(page: PageForJudgment): Promise<PageVerdict>;
  judgeEffect?(request: EffectRequest): Promise<EffectVerdict | null>;
  /** Under the `ask` policy: approve a held request. Absent, unanswered within `batchTimeoutMs` or cut, it is refused. */
  approveEffect?(request: EffectRequest, verdict: EffectVerdict | null): Promise<boolean>;
  /** One finite relevance per chunk, in order; ties go earlier. The scale must be absolute: a large text is ranked in
   *  several calls whose scores are compared. Null, a throw or a wrong count returns the text whole. */
  rankChunks?(find: string, chunks: string[]): Promise<number[] | null>;
};
