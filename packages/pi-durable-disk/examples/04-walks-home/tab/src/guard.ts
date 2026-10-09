// What reaches the screen: an answer is shown only after the dark-content judge has said show for the text shown. Progressive mode judges
// the text through each finished sentence and reveals that sentence when its prefix passes, so dark text is never sent anywhere, not
// for a frame; whole mode judges the finished answer once. Anything that is not exactly "show" is a refusal, and a failing judge is a
// refusal: the guard fails closed. Pure and injected, so the rule "a dark sentence never paints" is tested.

export const REFUSAL = "I can't answer that.";

/** The index just past the last sentence end in `text` (0 if none): . ! ? or … then spaces, or a blank line. A full stop at the very end is not an end yet (it may be "3.5"). */
export function sentenceEnd(text: string): number {
  const re = /[.!?…]+["'”’)\]*]*\s+|\n\s*\n/g;
  let end = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}

export interface GuardDeps {
  mode: 'progressive' | 'whole';
  /** Ask the judge about an answer (or a prefix of one). Rejecting counts as refusing. */
  judge(answer: string): Promise<'show' | 'refuse'>;
  /** The answer shown so far, only ever text the judge passed. */
  emit(shown: string): void;
  /** Stop the generation (a prefix was refused). */
  abort(): void;
}

export class Guard {
  private readonly d: GuardDeps;
  private latest = '';
  private shown = '';
  private covered = 0; // how much of the text a judgement has been asked for
  private inflight: Promise<void> | null = null;
  private refused = false;
  private stopped = false;

  constructor(d: GuardDeps) {
    this.d = d;
  }

  private async ask(prefix: string): Promise<boolean> {
    let v: unknown;
    try { v = await this.d.judge(prefix); } catch { v = 'refuse'; }
    if (this.stopped) return false; // the answer is over: a late verdict neither shows nor stops anything
    if (v !== 'show') {
      if (!this.refused) { this.refused = true; this.d.abort(); }
      return false;
    }
    this.shown = prefix;
    this.d.emit(prefix);
    return true;
  }

  private pump(): void {
    if (this.stopped || this.refused || this.inflight || this.d.mode !== 'progressive') return;
    const end = sentenceEnd(this.latest);
    if (end <= this.covered) return;
    this.covered = end;
    const prefix = this.latest.slice(0, end).trimEnd();
    this.inflight = this.ask(prefix).then(() => { this.inflight = null; this.pump(); });
  }

  /** The answer is over for good (the generation failed): nothing is emitted or judged from now on, whatever the judge still owes. */
  stop(): void {
    this.stopped = true;
  }

  /** The text generated so far (cumulative). */
  push(text: string): void {
    this.latest = text;
    this.pump();
  }

  /** The generation is over with `text`: judge what no sentence end covered, and return what the user may see. */
  async finish(text: string): Promise<{ refused: boolean; text: string }> {
    this.latest = text;
    while (this.inflight) await this.inflight;
    if (this.refused) return { refused: true, text: REFUSAL };
    const full = text.trim();
    if (full === '') return { refused: false, text: '' };
    if (full !== this.shown && !(await this.ask(full))) return { refused: true, text: REFUSAL };
    return { refused: false, text: full };
  }
}
