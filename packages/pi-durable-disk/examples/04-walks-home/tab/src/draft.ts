// The live sketch and its save, in order. Every stroke rebuilds the creature after a short rest and the drawing is saved after a
// longer one; `commit()` saves at once. The rule that matters: a commit never saves a body that is not the latest drawing, so it
// waits for a rebuild already running, builds anything drawn since (with the save), and only saves on its own when nothing is
// pending. Built from injected functions and timers so the ordering is testable.

export interface DraftOptions {
  /** Rebuild the creature from the current sketch; with `save`, also write the files. */
  build: (save: boolean) => Promise<void>;
  /** Write the current sketch's files without rebuilding (nothing has changed since the last build). */
  save: () => Promise<void>;
  onError?: (e: Error) => void;
  liveMs?: number;
  saveMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class DraftCommitter {
  private readonly o: DraftOptions;
  private liveTimer: unknown = null;
  private saveTimer: unknown = null;
  private building: Promise<void> | null = null;

  constructor(o: DraftOptions) {
    this.o = o;
  }

  private set(fn: () => void, ms: number): unknown { return (this.o.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms); }
  private clear(t: unknown): void { (this.o.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t); }

  /** Track a build so a commit can wait for it. */
  private run(save: boolean): Promise<void> {
    const p: Promise<void> = this.o.build(save).finally(() => { if (this.building === p) this.building = null; });
    this.building = p;
    return p;
  }

  /** The sketch changed: rebuild after a short rest, save after a longer one. */
  edit(): void {
    if (this.liveTimer !== null) this.clear(this.liveTimer);
    if (this.saveTimer !== null) this.clear(this.saveTimer);
    this.liveTimer = this.set(() => {
      this.liveTimer = null;
      this.run(false).catch((e) => this.o.onError?.(e as Error));
    }, this.o.liveMs ?? 300);
    this.saveTimer = this.set(() => {
      this.saveTimer = null;
      this.commit().catch((e) => this.o.onError?.(e as Error));
    }, this.o.saveMs ?? 1500);
  }

  /** Save the latest drawing now. Resolves when its files are written. */
  async commit(): Promise<void> {
    if (this.saveTimer !== null) { this.clear(this.saveTimer); this.saveTimer = null; }
    for (;;) {
      if (this.building) { await this.building.catch(() => {}); continue; } // a rebuild is running: it may be of an older drawing
      if (this.liveTimer !== null) { // a drawing no build has seen yet: build it, with the save
        this.clear(this.liveTimer);
        this.liveTimer = null;
        await this.run(true);
        return;
      }
      break;
    }
    await this.o.save();
  }
}
