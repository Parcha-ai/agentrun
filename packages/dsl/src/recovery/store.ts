// The store contract of durable recovery: where one run's journal lives, and the only way a recovery driver reads and
// writes it. A driver decides what is stored; a store keeps it, one atomic commit per write. The at-most-once rule for
// effects rests on three things every store must hold: an admission is durable, together with the state it carries,
// before `admit` resolves; an effect admitted and never completed stays `unknown` across every later open; and a
// journal has one owner at a time.

/** What a journal is bound to: one digest over everything that must not change between two opens of the same run, and
 *  the digest of each input it covers, by name, so that a refused open names the inputs that moved. */
export type RecoveryBinding = { binding: string; inputs?: Record<string, string> };

/** A decision recorded beside the state, with the revision of the commit that wrote it. */
export type RecoveryNote = { revision: number; kind: "escalation" | "handoff" | "inherited"; detail: unknown; at: string };

/** An effect as the journal holds it. `unknown` is admitted and never completed: nobody knows whether it happened, and
 *  it is never dispatched again. `session` names the identity it was admitted under, or is null. */
export type RecoveryEffect = { id: string; name: string; argsHash: string; status: "unknown" | "completed"; session: string | null; result: unknown };

/** One run's journal, held by the driver that opened it. Every write is one commit: it lands whole or not at all, it is
 *  durable before its promise resolves, it is refused once a later open has taken the journal, and it advances the
 *  revision by one. Values are stored as plain JSON with finite numbers. */
export type RecoveryJournal = {
  /** Whether an earlier open bound this journal. */
  readonly existing: boolean;
  /** This open's ownership generation: one more than the open before it. */
  readonly generation: number;
  /** The state the last commit before this open left, or null before the first. */
  readonly state: unknown;
  /** The revision of the last commit: the journal's own counter, one per commit, never reused. */
  readonly revision: number;
  /** Every effect admitted so far, in any status. */
  effects(): RecoveryEffect[];
  effect(id: string): RecoveryEffect | undefined;
  notes(): RecoveryNote[];
  /** Commit a state computed with the commit's own revision, so a row that names its revision is never durable without
   *  it, and a note when the state records a decision. Resolves to that revision. */
  save(state: (revision: number) => unknown, note?: Pick<RecoveryNote, "kind" | "detail">): Promise<number>;
  /** Commit the state, and a note when the state records a decision. Resolves to the commit's revision. */
  save(state: unknown, note?: Pick<RecoveryNote, "kind" | "detail">): Promise<number>;
  /** Commit a note with no state change. Resolves to the commit's revision. */
  note(kind: RecoveryNote["kind"], detail: unknown): Promise<number>;
  /** Admit an effect before it is dispatched, with the state that admits it, in one commit. An id already admitted is
   *  returned as it stands and nothing is written. */
  admit(id: string, name: string, argsHash: string, state: unknown, session?: string | null): Promise<"new" | RecoveryEffect>;
  /** Complete an admitted effect with its result, and the state that follows, in one commit. An effect completes once,
   *  and never without an admission. With no state given, the state stays as this open found it: that is how an
   *  operator reconciles an unknown effect. */
  complete(id: string, result: unknown, state?: unknown): Promise<void>;
  /** Keep the outside calls an admitted effect made, whether or not the effect completes. They are evidence for the
   *  host, which reads them from its store; no resume depends on them, so the journal has no read for them. */
  called(id: string, calls: unknown): Promise<void>;
  /** Let go of the journal. No later commit is made through this open, and the next open is the next generation. */
  close(): Promise<void>;
};

/** Where one run's journal lives. `open` takes ownership of it: a journal that is already open is refused, a binding
 *  that differs from the one the journal was first opened under is refused naming the inputs that moved, and the
 *  generation advances. */
export type RecoveryStore = {
  open(bound: RecoveryBinding): Promise<RecoveryJournal>;
};
