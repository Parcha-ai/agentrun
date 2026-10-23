// The store contract of durable recovery: where one run's journal lives, and the only way a recovery driver reads and
// writes it. A driver decides what is stored; a store keeps it, one atomic commit per write. The at-most-once rule for
// effects rests on three things every store must hold: an admission is durable, together with the state it carries,
// before `admit` resolves; an effect admitted and never completed stays `unknown` across every later open; and a
// journal has one owner at a time.

/** What a journal is bound to: one digest over everything that must not change between two opens of the same run, and
 *  the digest of each input it covers, by name, so that a refused open names the inputs that moved. */
export type RecoveryBinding = { binding: string; inputs?: Record<string, string> };

/** A decision recorded beside the state, with the revision of the commit that wrote it. `layout` says once per open
 *  that the driver keeps the whole state in one record although the host asked for the keyed layout, and why. */
export type RecoveryNote = { revision: number; kind: "escalation" | "handoff" | "inherited" | "layout"; detail: unknown; at: string };

/** A map item's record, as a store keeps it beside the state: plain JSON the driver writes and reads back. The store
 *  reads one field of it, `effects`: the ids of the effects admitted with this item as their owner. */
export type RecoveryItem = { effects: string[]; [field: string]: unknown };

/** What a write keeps beside the state, in the same commit: map items' records by item path, each replacing the one
 *  before it whole, and states by their digest (`canonicalHash`), each written once and never changed. Computed with
 *  the commit's revision, after the state. */
export type RecoveryParts = { items?: Record<string, RecoveryItem>; states?: Record<string, unknown> };

/** The external call an effect stands for: the tool it calls and the hash of the arguments it calls it with
 *  (`canonicalHash` of the arguments). A continuation's own call is keyed the same way, so a call that repeats an
 *  effect is known for one whatever the effect's status. */
export type RecoveryIntent = { tool: string; argsHash: string };

/** An effect as the journal holds it. `unknown` is admitted and never completed: nobody knows whether it happened, and
 *  it is never dispatched again. `session` names the identity it was admitted under, or is null. `intent` names the
 *  external call it was admitted for, when it makes one; an effect admitted without one has no `intent` key. */
export type RecoveryEffect = { id: string; name: string; argsHash: string; status: "unknown" | "completed"; session: string | null; result: unknown; intent?: RecoveryIntent; args?: unknown; calls?: unknown[] };

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
   *  it, and a note when the state records a decision, and the parts that go with it. Resolves to that revision. */
  save(state: (revision: number) => unknown, note?: Pick<RecoveryNote, "kind" | "detail">, parts?: (revision: number) => RecoveryParts): Promise<number>;
  /** Commit the state, and a note when the state records a decision, and the parts that go with it. Resolves to the
   *  commit's revision. */
  save(state: unknown, note?: Pick<RecoveryNote, "kind" | "detail">, parts?: (revision: number) => RecoveryParts): Promise<number>;
  /** Commit a note with no state change. Resolves to the commit's revision. */
  note(kind: RecoveryNote["kind"], detail: unknown): Promise<number>;
  /** Admit an effect before it is dispatched, with the state that admits it, in one commit, and the external call it
   *  makes when it makes one: the intent is kept with the effect from its admission, through its completion, at every
   *  later open. `args` are the call's arguments as the driver admitted it, kept with the effect as the host's door is sent them
   *  (an optional field: a record without them reads as it always did). A store that does not keep them leaves a call that was
   *  admitted and never sent unsettleable: a host's `reconcile` cannot re-send it, and the resume refuses it
   *  (`FROZEN_EFFECT_UNKNOWN`). An id already admitted is returned as it stands and nothing is written. `owner` names the
   *  map item whose record lists the effect, written in `parts` in the same commit: a store that keeps parts lists the
   *  effect there, and needs not list it again. */
  admit(id: string, name: string, argsHash: string, state: unknown, session?: string | null, intent?: RecoveryIntent, args?: unknown, parts?: (revision: number) => RecoveryParts, owner?: string): Promise<"new" | RecoveryEffect>;
  /** Complete an admitted effect with its result, and the state that follows, in one commit. An effect completes once,
   *  and never without an admission. With no state given, the state stays as this open found it: that is how an
   *  operator reconciles an unknown effect. */
  complete(id: string, result: unknown, state?: unknown, parts?: (revision: number) => RecoveryParts): Promise<void>;
  /** Keep the outside calls an admitted effect made, whether or not the effect completes: the list given replaces the one the
   *  effect held, and the effect's `calls` carries it from then on, at every later open. They are evidence for the host; no
   *  resume depends on them. A caller that adds to the calls an earlier process kept passes the earlier ones first. */
  called(id: string, calls: unknown): Promise<void>;
  /** Let go of the journal. No later commit is made through this open, and the next open is the next generation. */
  close(): Promise<void>;
  /** The records of the map items at `paths`, as the last commit that wrote each left it (undefined for one never
   *  written), so a driver reads back what it wrote in `parts`. The effects they list are then in `effects()` too.
   *  A store that keeps parts has both `items` and `stateOf`; a store without them cannot keep the keyed layout, and the
   *  driver keeps the whole state in one record there. */
  items?(paths: string[]): Promise<Array<RecoveryItem | undefined>>;
  /** The state written in `parts` under `sha256`, or undefined. */
  stateOf?(sha256: string): Promise<unknown>;
};

/** Where one run's journal lives. `open` takes ownership of it: a journal that is already open is refused, a binding
 *  that differs from the one the journal was first opened under is refused naming the inputs that moved, and the
 *  generation advances. */
export type RecoveryStore = {
  open(bound: RecoveryBinding): Promise<RecoveryJournal>;
};
