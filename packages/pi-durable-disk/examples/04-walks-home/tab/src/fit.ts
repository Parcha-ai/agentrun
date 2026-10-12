// Which of the installed skills were taught for the body on screen: the snapshot the stage reads (creature/fit.json in the run's work/) and the writer that keeps the latest one on its way to the disk until
// it lands. Pure: the write and the wait are the caller's.

/** The body a skill's policy file was taught for (its `mjcf_sha256`), or null when the file does not say. */
export const taughtFor = (policyText: string): string | null => {
  try { const v = (JSON.parse(policyText) as { mjcf_sha256?: unknown }).mjcf_sha256; return typeof v === 'string' ? v : null; } catch { return null; }
};

export interface FitSnapshot {
  /** The file's text. */
  text: string;
  notFitting: string[];
  fitting: string[];
}

/** One entry per skill of the manifest whose policy this page has read, in the manifest's order; a skill that is not in the manifest (any more) is not in the file. */
export function fitSnapshot(bodySha: string, manifestOrder: readonly string[], texts: ReadonlyMap<string, string>): FitSnapshot {
  const entries = manifestOrder.filter((name) => texts.has(name)).map((name) => {
    const taught = taughtFor(texts.get(name)!);
    return [name, { fits: taught === bodySha, taught_for_body_sha: taught }] as const;
  });
  const notFitting = entries.filter(([, v]) => !v.fits).map(([name]) => name);
  const fitting = entries.filter(([, v]) => v.fits).map(([name]) => name);
  return { text: JSON.stringify({ version: 1, body_sha: bodySha, skills: Object.fromEntries(entries), not_fitting: notFitting }) + '\n', notFitting, fitting };
}

/**
 * Keeps the latest snapshot until it is on the disk: a write that fails is tried again after a wait (doubling, up to `maxWaitMs`) while it is still the latest, and a newer snapshot replaces an older one that
 * never landed. Submitting what is already on the disk does nothing.
 */
export class FitWriter {
  readonly #write: (text: string) => Promise<void>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #firstWaitMs: number;
  readonly #maxWaitMs: number;
  #written = '';
  #pending: string | undefined;
  #running: Promise<void> | undefined;
  #active = false;

  constructor(write: (text: string) => Promise<void>, sleep: (ms: number) => Promise<void>, firstWaitMs = 1000, maxWaitMs = 10_000) {
    this.#write = write;
    this.#sleep = sleep;
    this.#firstWaitMs = firstWaitMs;
    this.#maxWaitMs = maxWaitMs;
  }

  /** Make this the file's text. Resolves when the writer has nothing left to write (landed, or replaced by a later submit that landed). */
  submit(text: string): Promise<void> {
    if (text === this.#written && this.#pending === undefined) return this.#running ?? Promise.resolve();
    this.#pending = text;
    if (!this.#active) {
      this.#active = true; // set here and cleared by the loop in the same step it stops looking, so there is no moment when the loop is over and this still says it is running
      this.#running = this.#loop();
    }
    return this.#running!;
  }

  async #loop(): Promise<void> {
    let wait = this.#firstWaitMs;
    try {
      while (this.#pending !== undefined) {
        const text = this.#pending;
        try {
          await this.#write(text);
          this.#written = text;
          if (this.#pending === text) this.#pending = undefined;
          wait = this.#firstWaitMs;
        } catch {
          await this.#sleep(wait);
          wait = Math.min(wait * 2, this.#maxWaitMs);
        }
      }
    } finally {
      this.#active = false; // runs in the step that found nothing pending: a submit after this starts a new loop, one before it was seen by the check above
    }
  }
}
