// The lines the server sends a page that is still taking a run over. The pipe sends a page its `submit` frames as soon as the page has said `switched`, and the server's own home turn goes
// out about 15 ms later (it waits only for its check in code); the page is not yet the run's writer for a moment after that (its conversation is read once more, and on a slow link or a loaded
// laptop that read is slow). A frame that arrives in that moment is kept and run when the page is ready, and one that arrives when the page is not taking a run over is dropped, as before.
// Portable: no Node API, no DOM API.

/** What the page is doing when a frame arrives: `ready` it runs the run, `starting` it is taking the run over, `gone` it is not (a viewer, lost, offline). */
export type GatePhase = "ready" | "starting" | "gone";

export class SubmitGate<T> {
  readonly #run: (frame: T) => void;
  #held: T[] = [];
  /** Closed from `begin` (a page starts taking a run over) to `open` (it is ready for what it was sent): every frame in between waits its turn, however the page's mode reads. */
  #closed = false;

  constructor(run: (frame: T) => void) {
    this.#run = run;
  }

  /** The page starts taking a run over: from here nothing runs until `open`, and the frames that arrive meanwhile run in the order they came. */
  begin(): void {
    this.#closed = true;
  }

  /** A frame arrived: run it now, hold it until `open`, or drop it. Returns what became of it. A frame is never run ahead of one that is held, whatever the phase says. */
  offer(frame: T, phase: GatePhase): "ran" | "held" | "dropped" {
    if ((this.#closed && phase !== "gone") || (phase === "ready" && this.#held.length > 0)) {
      this.#held.push(frame);
      return "held";
    }
    if (phase === "ready") {
      this.#run(frame);
      return "ran";
    }
    if (phase === "starting") {
      this.#held.push(frame);
      return "held";
    }
    return "dropped";
  }

  /** The page is the writer now: what was held runs, in the order it came. */
  open(): number {
    this.#closed = false;
    const held = this.#held;
    this.#held = [];
    for (const frame of held) this.#run(frame);
    return held.length;
  }

  /** The page stopped taking the run over (lost, left, closed): what was held is not run. */
  discard(): number {
    const n = this.#held.length;
    this.#held = [];
    this.#closed = false;
    return n;
  }

  get held(): number {
    return this.#held.length;
  }
}
