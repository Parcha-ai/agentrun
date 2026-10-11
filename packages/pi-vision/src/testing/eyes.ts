// Fake eyes: scripted answers in order (the last one repeats), a ledger of every request in arrival order, and the
// sentinel key held the way a real eyes object holds its credential. A failure carries the key on the error's request,
// as SDK errors carry their request headers, so a test proves no error detail reaches a result. With `ledgerPath`, each
// request is also appended to that file as one JSON line before it is answered, so a parent process counts the
// requests of a child it killed.

import { appendFileSync } from "node:fs";
import type { Eyes, EyesAnswer, Usage } from "../core/host.js";
import { DEFAULT_LIMITS, type Limits } from "../core/limits.js";
import type { Part } from "../core/plan.js";
import { SENTINEL_EYES_KEY } from "./sentinels.js";

/** A scripted answer: the text, or the text with its model, tokens, price or billing; a failure; or a request that
 *  never answers until it is aborted. */
export type FakeAnswer =
  | string
  | { readonly text: string; readonly model?: string; readonly input?: number; readonly output?: number; readonly costUsd?: number | null; readonly billedBy?: string; readonly delayMs?: number }
  | { readonly fail: string }
  | { readonly hang: true };

export type FakeEyesRequest = {
  /** 1-based, in arrival order. */
  readonly n: number;
  readonly ask: string;
  readonly context?: string;
  readonly parts: readonly { readonly type: Part["type"]; readonly mimeType?: string; readonly fragment?: string; readonly width?: number; readonly height?: number; readonly chars: number }[];
};

export type FakeEyesOptions = {
  /** Default "fake-eyes". */
  readonly model?: string;
  readonly accepts?: Partial<Eyes["accepts"]>;
  readonly limits?: Limits;
  readonly answers?: readonly (FakeAnswer | ((request: FakeEyesRequest) => FakeAnswer))[];
  /** Dollars per million input and output tokens. Null: the price is unknown and every answer's cost is null. */
  readonly price?: { readonly input: number; readonly output: number } | null;
  readonly ledgerPath?: string;
};

export type FakeEyes = Eyes & {
  readonly ledger: readonly FakeEyesRequest[];
  /** The credential this fake holds. */
  readonly apiKey: string;
};

/** Input tokens a fake request counts: a flat 1,000 a media part and one per four characters of text. */
const tokensIn = (request: FakeEyesRequest) => request.parts.reduce((sum, part) => sum + (part.type === "text" ? Math.ceil(part.chars / 4) : 1000), Math.ceil((request.ask.length + (request.context?.length ?? 0)) / 4));

const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" });

export function fakeEyes(options: FakeEyesOptions = {}): FakeEyes {
  const ledger: FakeEyesRequest[] = [];
  const answers = options.answers?.length ? options.answers : ["fake answer"];
  const model = options.model ?? "fake-eyes";
  const price = options.price === undefined ? { input: 1, output: 4 } : options.price;
  const eyes: FakeEyes = {
    model,
    accepts: { image: true, video: false, pdf: false, ...options.accepts },
    limits: options.limits ?? DEFAULT_LIMITS,
    ledger,
    apiKey: SENTINEL_EYES_KEY,
    async see(request, signal): Promise<EyesAnswer> {
      const entry: FakeEyesRequest = {
        n: ledger.length + 1, ask: request.ask, ...(request.context !== undefined ? { context: request.context } : {}),
        parts: request.parts.map((part) => part.type === "text"
          ? { type: part.type, ...(part.fragment ? { fragment: part.fragment } : {}), chars: part.text.length }
          : { type: part.type, mimeType: part.mimeType, fragment: part.fragment, ...(part.type === "image" ? { width: part.width, height: part.height } : {}), chars: part.data.length }),
      };
      ledger.push(entry);
      if (options.ledgerPath) appendFileSync(options.ledgerPath, `${JSON.stringify(entry)}\n`);
      const scripted = answers[Math.min(entry.n, answers.length) - 1]!;
      const answer = typeof scripted === "function" ? scripted(entry) : scripted;
      if (signal.aborted) throw abortError(signal);
      if (typeof answer === "object" && "hang" in answer) {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError(signal)), { once: true }));
      }
      if (typeof answer === "object" && "fail" in answer) {
        throw Object.assign(new Error(answer.fail), { request: { headers: { authorization: `Bearer ${SENTINEL_EYES_KEY}` } } });
      }
      const spec = typeof answer === "string" ? { text: answer } : answer;
      if (spec.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, spec.delayMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(abortError(signal)); }, { once: true });
        });
      }
      const input = spec.input ?? tokensIn(entry);
      const output = spec.output ?? Math.ceil(spec.text.length / 4);
      const cost = price ? { input: (input * price.input) / 1e6, output: (output * price.output) / 1e6 } : { input: 0, output: 0 };
      const usage: Usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { ...cost, cacheRead: 0, cacheWrite: 0, total: cost.input + cost.output } };
      const costUsd = spec.costUsd !== undefined ? spec.costUsd : price ? usage.cost.total : null;
      return { text: spec.text, model: spec.model ?? model, usage, costUsd, ...(spec.billedBy ? { billedBy: spec.billedBy } : {}) };
    },
  };
  return eyes;
}
