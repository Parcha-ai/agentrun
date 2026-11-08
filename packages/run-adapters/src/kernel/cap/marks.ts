// The cap's marks: the port the run's journal binds (each mark written in the step's own commit), and a test double. A
// paid step's start mark, with what it is held at, is written before the step leaves; its end mark, with what it was
// booked at, before its result is given back. Every mark is keyed by its step's id, so a reopened run counts an end
// against its own step, never another (recover.ts).

/** A step's start: what it is held at (null: no figure, as an older store kept none), and its bound (what a cache miss
 *  can add). `refused`: the cap refused it, and it never left. `tool`: a paid call's name. */
export type StartMark = {
  readonly kind: "start";
  readonly id: string;
  readonly at: number;
  readonly heldUsd: number | null;
  readonly boundUsd?: number;
  readonly side?: true;
  readonly tool?: string;
  readonly refused?: true;
};
/** A step's end: what it was booked at (null: unknown), and the booking rule that gave it. */
export type EndMark = { readonly kind: "end"; readonly id: string; readonly at: number; readonly usd: number | null; readonly rule?: string };
export type CapMark = StartMark | EndMark;

export interface CapMarks {
  /** Writes `mark` durably (the journal: in the step's own commit). Rejects when it could not be written. */
  write(mark: CapMark): Promise<void>;
  /** Every mark of the run, in the order written. */
  read(): Promise<CapMark[]>;
}

/** CapMarks in memory, for tests: `failNext()` makes the next write reject, `hang()` makes every write after it wait
 *  forever, as a store whose write never settles. */
export function memoryMarks(initial: readonly CapMark[] = []): CapMarks & { all(): CapMark[]; failNext(): void; hang(): void } {
  const marks: CapMark[] = [...initial];
  let fail = false;
  let hung = false;
  return {
    async write(mark) {
      if (hung) return new Promise<void>(() => {});
      if (fail) {
        fail = false;
        throw new Error("the mark could not be written");
      }
      marks.push(mark);
    },
    async read() {
      return [...marks];
    },
    all: () => [...marks],
    failNext: () => void (fail = true),
    hang: () => void (hung = true),
  };
}
