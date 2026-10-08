// Decision hooks: typed judgments the package asks the host for where a semantic answer drives a structural action
// (file a page `failed`, hold a request, keep a chunk). The package never answers them itself and knows no model; a
// host without a hook is asked nothing, and a hook that returns null or "unjudged" leaves the default action.

/** What a page that is not the content asked for can be; code routes each class to its own way out. */
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
  /** The host's own record of this judgment, one line, filed verbatim as the receipt's `page_guard` fact so the
   *  decision re-derives from the receipt with no model call. */
  guard?: string;
};

/** A non-GET request a `run` would send, as the observer saw it. Never a body, a header value or a field value. */
export type EffectRequest = {
  method: string;
  origin: string;
  path: string;
  queryKeys: string[];
  formFields: string[];
  pageTitle: string | null;
  /** The text of the button or link that triggered it, when the observer has it. */
  trigger: string | null;
  /** The run's task, as the host states it. */
  task: string | null;
};

/** Probabilities, each in [0, 1]. */
export type EffectVerdict = { irreversible: number; telemetry: number; queryOnly: number };

export type Decisions = {
  classifyPage?(page: PageForJudgment): Promise<PageVerdict>;
  judgeEffect?(request: EffectRequest): Promise<EffectVerdict | null>;
  /** Under the `ask` action policy: the host's answer for a held request judged irreversible, or not judged. Absent,
   *  or not answered within the policy's `batchTimeoutMs` or before the call is cut, the request is refused. */
  approveEffect?(request: EffectRequest, verdict: EffectVerdict | null): Promise<boolean>;
  /** One relevance per chunk, in the chunks' order: any finite numbers, higher is more relevant, ties go to the earlier
   *  chunk. The scale is absolute, not relative to the other chunks of the call: a text of more than 200 chunks is ranked in
   *  several calls and their scores are compared. Null, a throw or a wrong count leaves the text unranked and `find` returns it whole. */
  rankChunks?(find: string, chunks: string[]): Promise<number[] | null>;
};
