// Token limits on a generation that is read as it streams: "from the first `start` in the text (or from the beginning), `end` must appear within `tokens` tokens".
// A backend feeds it the text so far and the token count after each chunk and stops the generation when it says a limit was hit. Used by the tab's wllama backend and by the scorer's
// llama-server backend, so a turn is cut at the same place in both. Pure.

export interface Limit {
  /** Where the clock starts: the first occurrence of this text; null: the beginning of the generation. */
  start: string | null;
  /** The text that must appear (after `start`) before the clock runs out. */
  end: string;
  /** How many tokens after `start` (before the end of `end`'s first appearance) the generation may take. */
  tokens: number;
}

export class LimitTracker {
  readonly #limits: readonly Limit[];
  readonly #startedAt: (number | undefined)[];

  constructor(limits: readonly Limit[] = []) {
    this.#limits = limits;
    this.#startedAt = limits.map((l) => (l.start === null ? 0 : undefined));
  }

  /** The index of the limit that ran out, or -1. Call after each chunk with the whole text so far and the tokens so far. */
  push(text: string, tokens: number): number {
    for (const [i, limit] of this.#limits.entries()) {
      let from = 0;
      if (limit.start !== null) {
        const at = text.indexOf(limit.start);
        if (at < 0) continue;
        this.#startedAt[i] ??= tokens;
        from = at + limit.start.length;
      }
      if (text.indexOf(limit.end, from) >= 0) continue; // satisfied
      if (tokens - (this.#startedAt[i] ?? tokens) >= limit.tokens) return i;
    }
    return -1;
  }
}
