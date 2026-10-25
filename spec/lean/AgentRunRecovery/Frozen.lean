/-!
# A recovery driver's effects

A workflow's call steps run in order over a journal (`packages/dsl/src/recovery/store.ts`,
`RecoveryJournal`). Each step's effect is admitted before it dispatches and completed with its
result after, each in one commit with the driver's state. A resumed driver answers a completed
effect from the journal and refuses one that was admitted and never completed. A crash loses only
what the process held: an admission not yet dispatched, an effect in flight.

`spec/receipts/Receipts.tla` states the same machine and TLC checks it at small bounds (a few steps,
a few crashes). The theorems here hold for every number of steps and every number of crashes, with a
commit failure or a crash between any two actions.

| Transition | What it is |
| --- | --- |
| `admit` | `RecoveryJournal.admit`: the effect is on the journal, `unknown`, before anything goes out |
| `dispatch` | the effect goes out; only the effect this process admitted, once (the interpreter runs no call retry under recovery) |
| `settle` | `RecoveryJournal.complete`: the result and the driver's next state in one commit |
| `lost` | the effect's outcome is not known: the run is refused |
| `answer` | a resumed driver meets a completed effect: answered from its receipt, no dispatch |
| `refuse` | a resumed driver meets an `unknown` effect: refused, no dispatch |
| `fail` | a commit fails: the run stops, and no later commit is made through that open |
| `cancel` | the host cancels: the driver applies the stop at once, and the run reports it; its commit follows |
| `commitStop` | the stop's commit lands: the journal holds the stop |
| `stopRefused` | the store refuses the stop's commit |
| `close` | the host lets go of the driver once the stop's commit landed or failed; close throws a refused one |
| `crash` | the worker dies and restarts under the same identity, from a checkpoint at or before the journal's position; a stop the journal does not hold dies with it, and the run resumes |

- `admit_before_dispatch`: an effect that went out is on the journal.
- `one_dispatch_per_effect`: no effect goes out twice, whatever crashed.
- `completed_dispatched_once`: a completed effect went out exactly once.
- `completed_never_redispatched`: from a completed effect, no step sends it again or changes it: a
  resume answers it from its receipt.
- `admitted_elsewhere_never_resent`: an effect on the journal that this process did not admit (a
  resumed driver's `unknown` effect, or a completed one) is never sent again, over any number of
  later steps, crashes and failures.
- `never_past_uncompleted`: the driver never moves past an effect it did not complete.
- `resume_answers_completed`: a reachable state meets a completed effect on resume, so the theorems
  above cover the `answer` step.
- `stop_on_journal_or_heard`: a stop the host let go of is on the journal, or the host heard that it is
  not.
- `stop_admits_nothing`: a run with a stop applied, or whose journal holds its stop, admits and settles
  nothing.
- `cancelled_never_resumes`: once the journal holds the stop, no later step, crash or restart changes an
  effect on the journal.
- `stop_refused_heard`: a reachable state has the host told of a stop the journal does not hold and
  hearing it, so `stop_on_journal_or_heard` covers a refused stop commit.
-/

namespace AgentRunRecovery
namespace Frozen

inductive Status where
  | none | unknown | completed
  deriving DecidableEq, Repr

inductive Run where
  | running | refused | faulted | done | stopped
  deriving DecidableEq, Repr

/-- The stop this process applied: none, its commit not yet landed, landed, or refused by the store. -/
inductive Stop where
  | none | pending | landed | refused
  deriving DecidableEq, Repr

/-- The driver and the world it acts on. Steps are `0 .. n - 1`; `pos` is the step it is on; `sent i` counts the dispatches of
    step `i`'s effect the world saw. `memo` is the journal's effects. `stop` is the stop this process applied and
    `stopped` whether the journal holds it; `told` is whether the run reported a stop to the host, `closed` whether
    the host let go of the driver after it, and `heard` whether close threw its refused commit. -/
structure Driver where
  n : Nat
  memo : Nat → Status
  sent : Nat → Nat
  pos : Nat
  fresh : Option Nat
  flight : Option Nat
  run : Run
  stop : Stop
  stopped : Bool
  told : Bool
  closed : Bool
  heard : Bool

/-- `f` with `k` set to `v`. -/
def upd {α : Type} (f : Nat → α) (k : Nat) (v : α) : Nat → α := fun j => if j = k then v else f j

def init (n : Nat) : Driver :=
  { n, memo := fun _ => .none, sent := fun _ => 0, pos := 0, fresh := none, flight := none, run := .running,
    stop := .none, stopped := false, told := false, closed := false, heard := false }

inductive Step : Driver → Driver → Prop where
  | admit (d : Driver) : d.run = .running → d.pos < d.n → d.flight = none → d.fresh = none → d.memo d.pos = .none →
      Step d { d with memo := upd d.memo d.pos .unknown, fresh := some d.pos }
  | dispatch (d : Driver) : d.run = .running → d.fresh = some d.pos → d.memo d.pos = .unknown →
      Step d { d with sent := upd d.sent d.pos (d.sent d.pos + 1), flight := some d.pos, fresh := none }
  | settle (d : Driver) : d.run = .running → d.flight = some d.pos →
      Step d { d with memo := upd d.memo d.pos .completed, pos := d.pos + 1, flight := none }
  | lost (d : Driver) : d.run = .running → d.flight = some d.pos → Step d { d with run := .refused, flight := none }
  | answer (d : Driver) : d.run = .running → d.flight = none → d.fresh = none → d.pos < d.n → d.memo d.pos = .completed →
      Step d { d with pos := d.pos + 1 }
  | refuse (d : Driver) : d.run = .running → d.flight = none → d.fresh = none → d.memo d.pos = .unknown →
      Step d { d with run := .refused }
  | finish (d : Driver) : d.run = .running → d.pos = d.n → Step d { d with run := .done }
  | fail (d : Driver) : Step d { d with run := .faulted }
  | cancel (d : Driver) : d.run = .running → d.stop = .none →
      Step d { d with run := .stopped, stop := .pending, told := true, closed := false, heard := false }
  | commitStop (d : Driver) : d.stop = .pending → Step d { d with stop := .landed, stopped := true }
  | stopRefused (d : Driver) : d.stop = .pending → Step d { d with stop := .refused }
  | close (d : Driver) : (d.stop = .landed ∨ d.stop = .refused) → d.closed = false →
      Step d { d with closed := true, heard := decide (d.stop = .refused) }
  | crash (d : Driver) (p : Nat) : p ≤ d.pos →
      Step d { d with fresh := none, flight := none, pos := p, stop := .none,
                      run := if d.run = .stopped ∧ d.stopped = false then .running else d.run }

/-- The states a run reaches from its start, whatever the interleaving of steps, crashes and failures. -/
inductive Reach : Driver → Prop where
  | init (n : Nat) : Reach (init n)
  | step {d d' : Driver} : Reach d → Step d d' → Reach d'

/-- What every reachable state holds. -/
structure Inv (d : Driver) : Prop where
  none_unsent : ∀ i, d.memo i = .none → d.sent i = 0
  fresh_unsent : ∀ i, d.fresh = some i → d.memo i = .unknown ∧ d.sent i = 0
  flight_sent : ∀ i, d.flight = some i → d.memo i = .unknown ∧ d.sent i = 1
  at_most_once : ∀ i, d.sent i ≤ 1
  completed_once : ∀ i, d.memo i = .completed → d.sent i = 1
  behind_completed : ∀ i, i < d.pos → d.memo i = .completed

theorem inv_init (n : Nat) : Inv (init n) where
  none_unsent := by intro i _; rfl
  fresh_unsent := by intro i h; simp [init] at h
  flight_sent := by intro i h; simp [init] at h
  at_most_once := by intro i; simp [init]
  completed_once := by intro i h; simp [init] at h
  behind_completed := by intro i h; simp [init] at h

theorem inv_step {d d' : Driver} (h : Inv d) (s : Step d d') : Inv d' := by
  cases s with
  | admit hr hn hfl hfr hm =>
    constructor
    · intro i hi
      by_cases e : i = d.pos
      · subst e; simp [upd] at hi
      · simp [upd, e] at hi; exact h.none_unsent i hi
    · intro i hi
      simp at hi; subst hi
      exact ⟨by simp [upd], h.none_unsent _ hm⟩
    · intro i hi; simp [hfl] at hi
    · exact h.at_most_once
    · intro i hi
      by_cases e : i = d.pos
      · subst e; simp [upd] at hi
      · simp [upd, e] at hi; exact h.completed_once i hi
    · intro i hi
      have hi : i < d.pos := hi
      have := h.behind_completed i hi
      have e : i ≠ d.pos := by omega
      simp [upd, e, this]
  | dispatch hr hfr hm =>
    have z := (h.fresh_unsent _ hfr).2
    constructor
    · intro i hi
      by_cases e : i = d.pos
      · subst e; simp [hm] at hi
      · simp [upd, e]; exact h.none_unsent i hi
    · intro i hi; simp at hi
    · intro i hi
      simp at hi; subst hi
      exact ⟨hm, by simp [upd, z]⟩
    · intro i
      by_cases e : i = d.pos
      · subst e; simp [upd, z]
      · simp [upd, e]; exact h.at_most_once i
    · intro i hi
      by_cases e : i = d.pos
      · subst e; simp [hm] at hi
      · simp [upd, e]; exact h.completed_once i hi
    · exact h.behind_completed
  | settle hr hfl =>
    have f := h.flight_sent _ hfl
    constructor
    · intro i hi
      by_cases e : i = d.pos
      · subst e; simp [upd] at hi
      · simp [upd, e] at hi; exact h.none_unsent i hi
    · intro i hi
      have hf := h.fresh_unsent i hi
      by_cases e : i = d.pos
      · subst e; exact absurd hf.2 (by omega)
      · simp [upd, e]; exact hf
    · intro i hi; simp at hi
    · exact h.at_most_once
    · intro i hi
      by_cases e : i = d.pos
      · subst e; exact f.2
      · simp [upd, e] at hi; exact h.completed_once i hi
    · intro i hi
      have hi : i < d.pos + 1 := hi
      by_cases e : i = d.pos
      · subst e; simp [upd]
      · have : i < d.pos := by omega
        simp [upd, e, h.behind_completed i this]
  | lost hr hfl =>
    exact ⟨h.none_unsent, h.fresh_unsent, by intro i hi; simp at hi, h.at_most_once, h.completed_once, h.behind_completed⟩
  | answer hr hfl hfr hn hm =>
    refine ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, ?_⟩
    intro i hi
    have hi : i < d.pos + 1 := hi
    by_cases e : i = d.pos
    · subst e; exact hm
    · exact h.behind_completed i (by omega)
  | refuse _ _ _ _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | finish _ _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | fail => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | cancel _ _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | commitStop _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | stopRefused _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | close _ _ => exact ⟨h.none_unsent, h.fresh_unsent, h.flight_sent, h.at_most_once, h.completed_once, h.behind_completed⟩
  | crash p hp =>
    exact ⟨h.none_unsent, by intro i hi; simp at hi, by intro i hi; simp at hi, h.at_most_once, h.completed_once,
      fun i hi => h.behind_completed i (Nat.lt_of_lt_of_le hi hp)⟩

theorem inv_reach {d : Driver} (r : Reach d) : Inv d := by
  induction r with
  | init n => exact inv_init n
  | step _ s ih => exact inv_step ih s

/-- **F1.** An effect that went out is on the journal: it was admitted before it dispatched. -/
theorem admit_before_dispatch {d : Driver} (r : Reach d) (i : Nat) (h : d.sent i > 0) : d.memo i ≠ .none := by
  intro hn
  have := (inv_reach r).none_unsent i hn
  omega

/-- **F2.** No effect goes out twice, for any number of steps and any number of crashes. -/
theorem one_dispatch_per_effect {d : Driver} (r : Reach d) (i : Nat) : d.sent i ≤ 1 :=
  (inv_reach r).at_most_once i

/-- **F3.** A completed effect went out exactly once. -/
theorem completed_dispatched_once {d : Driver} (r : Reach d) (i : Nat) (h : d.memo i = .completed) : d.sent i = 1 :=
  (inv_reach r).completed_once i h

/-- **F4.** From a completed effect, no step sends it again or changes its receipt: a resume answers it
    from the journal. -/
theorem completed_never_redispatched {d d' : Driver} (r : Reach d) (s : Step d d') (i : Nat)
    (h : d.memo i = .completed) : d'.sent i = d.sent i ∧ d'.memo i = .completed := by
  have inv := inv_reach r
  cases s with
  | admit _ _ _ _ hm =>
    refine ⟨rfl, ?_⟩
    by_cases e : i = d.pos
    · subst e; rw [h] at hm; cases hm
    · simp [upd, e, h]
  | dispatch _ hfr hm =>
    by_cases e : i = d.pos
    · subst e; rw [h] at hm; cases hm
    · exact ⟨by simp [upd, e], h⟩
  | settle _ _ =>
    refine ⟨rfl, ?_⟩
    by_cases e : i = d.pos
    · subst e; simp [upd]
    · simp [upd, e, h]
  | lost _ _ => exact ⟨rfl, h⟩
  | answer _ _ _ _ _ => exact ⟨rfl, h⟩
  | refuse _ _ _ _ => exact ⟨rfl, h⟩
  | finish _ _ => exact ⟨rfl, h⟩
  | fail => exact ⟨rfl, h⟩
  | cancel _ _ => exact ⟨rfl, h⟩
  | commitStop _ => exact ⟨rfl, h⟩
  | stopRefused _ => exact ⟨rfl, h⟩
  | close _ _ => exact ⟨rfl, h⟩
  | crash _ _ => exact ⟨rfl, h⟩

/-- Any number of steps, crashes and failures. -/
inductive Steps : Driver → Driver → Prop where
  | refl (d : Driver) : Steps d d
  | tail {d d' d'' : Driver} : Steps d d' → Step d' d'' → Steps d d''

/-- What carries an effect admitted outside this process along every later step: it is not this
    process's admission, and it stays on the journal. -/
theorem held_step {d d' : Driver} (p : Nat) (s : Step d d') (hfr : d.fresh ≠ some p) (hm : d.memo p ≠ .none) :
    d'.fresh ≠ some p ∧ d'.memo p ≠ .none ∧ d'.sent p = d.sent p := by
  cases s with
  | admit _ _ _ _ hnone =>
    have e : p ≠ d.pos := by intro e; subst e; exact hm hnone
    refine ⟨by simp; exact fun h => e h.symm, by simp [upd, e]; exact hm, rfl⟩
  | dispatch _ hf _ =>
    have e : p ≠ d.pos := by intro e; subst e; exact hfr hf
    exact ⟨by simp, hm, by simp [upd, e]⟩
  | settle _ _ =>
    refine ⟨hfr, ?_, rfl⟩
    by_cases e : p = d.pos
    · subst e; simp [upd]
    · simp [upd, e]; exact hm
  | lost _ _ => exact ⟨hfr, hm, rfl⟩
  | answer _ _ _ _ _ => exact ⟨hfr, hm, rfl⟩
  | refuse _ _ _ _ => exact ⟨hfr, hm, rfl⟩
  | finish _ _ => exact ⟨hfr, hm, rfl⟩
  | fail => exact ⟨hfr, hm, rfl⟩
  | cancel _ _ => exact ⟨hfr, hm, rfl⟩
  | commitStop _ => exact ⟨hfr, hm, rfl⟩
  | stopRefused _ => exact ⟨hfr, hm, rfl⟩
  | close _ _ => exact ⟨hfr, hm, rfl⟩
  | crash _ _ => exact ⟨by simp, hm, rfl⟩

/-- **F5.** An effect on the journal that this process did not admit (a resumed driver's `unknown`
    effect, or a completed one) is never sent again, however many steps, crashes and failures follow.
    A resumed driver refuses the `unknown` one and answers the completed one from its receipt. -/
theorem admitted_elsewhere_never_resent {d d' : Driver} (path : Steps d d') (p : Nat)
    (hfr : d.fresh ≠ some p) (hm : d.memo p ≠ .none) : d'.sent p = d.sent p := by
  have key : d'.fresh ≠ some p ∧ d'.memo p ≠ .none ∧ d'.sent p = d.sent p := by
    induction path with
    | refl => exact ⟨hfr, hm, rfl⟩
    | tail _ s ih =>
      have ⟨f, m, e⟩ := ih
      have ⟨f', m', e'⟩ := held_step p s f m
      exact ⟨f', m', e'.trans e⟩
  exact key.2.2

/-- **F6.** The driver never moves past an effect it did not complete. -/
theorem never_past_uncompleted {d : Driver} (r : Reach d) (i : Nat) (h : i < d.pos) : d.memo i = .completed :=
  (inv_reach r).behind_completed i h

/-- **F7.** A resume meets a completed effect: one step admitted, sent and completed, then a crash back to
    the first step, reaches a state where `answer` is the next step. The theorems above cover that step,
    not only states where it cannot occur. -/
theorem resume_answers_completed : ∃ d d', Reach d ∧ d.memo d.pos = .completed ∧ Step d d' ∧ d'.sent = d.sent := by
  let d0 := init 1
  have r1 := Reach.step (Reach.init 1) (Step.admit d0 rfl (by decide) rfl rfl rfl)
  have r2 := Reach.step r1 (Step.dispatch _ rfl rfl (by simp [upd, d0, init]))
  have r3 := Reach.step r2 (Step.settle _ rfl rfl)
  have r4 := Reach.step r3 (Step.crash _ 0 (by simp))
  exact ⟨_, _, r4, by simp [upd, d0, init], Step.answer _ rfl rfl rfl (by simp [d0, init]) (by simp [upd, d0, init]), rfl⟩

/-- What every reachable state holds of a stop. -/
structure StopInv (d : Driver) : Prop where
  landed_on_journal : d.stop = .landed → d.stopped = true
  closed_known : d.closed = true → d.stopped = true ∨ d.heard = true
  applied_not_running : d.stop ≠ .none → d.run ≠ .running
  journal_not_running : d.stopped = true → d.run ≠ .running

theorem stop_inv_init (n : Nat) : StopInv (init n) where
  landed_on_journal := by intro h; simp [init] at h
  closed_known := by intro h; simp [init] at h
  applied_not_running := by intro h; simp [init] at h
  journal_not_running := by intro h; simp [init] at h

theorem stop_inv_step {d d' : Driver} (h : StopInv d) (s : Step d d') : StopInv d' := by
  cases s with
  | admit _ _ _ _ _ => exact ⟨h.landed_on_journal, h.closed_known, h.applied_not_running, h.journal_not_running⟩
  | dispatch _ _ _ => exact ⟨h.landed_on_journal, h.closed_known, h.applied_not_running, h.journal_not_running⟩
  | settle _ _ => exact ⟨h.landed_on_journal, h.closed_known, h.applied_not_running, h.journal_not_running⟩
  | lost _ _ => exact ⟨h.landed_on_journal, h.closed_known, by intro _; simp, by intro _; simp⟩
  | answer _ _ _ _ _ => exact ⟨h.landed_on_journal, h.closed_known, h.applied_not_running, h.journal_not_running⟩
  | refuse _ _ _ _ => exact ⟨h.landed_on_journal, h.closed_known, by intro _; simp, by intro _; simp⟩
  | finish _ _ => exact ⟨h.landed_on_journal, h.closed_known, by intro _; simp, by intro _; simp⟩
  | fail => exact ⟨h.landed_on_journal, h.closed_known, by intro _; simp, by intro _; simp⟩
  | cancel _ _ => exact ⟨by intro e; simp at e, by intro e; simp at e, by intro _; simp, by intro _; simp⟩
  | commitStop hp =>
    have hr : d.run ≠ .running := h.applied_not_running (by rw [hp]; simp)
    exact ⟨fun _ => rfl, fun _ => Or.inl rfl, fun _ => hr, fun _ => hr⟩
  | stopRefused hp =>
    have hr : d.run ≠ .running := h.applied_not_running (by rw [hp]; simp)
    exact ⟨by intro e; simp at e, h.closed_known, fun _ => hr, h.journal_not_running⟩
  | close hl _ =>
    refine ⟨h.landed_on_journal, ?_, h.applied_not_running, h.journal_not_running⟩
    intro _
    rcases hl with hl | hl
    · exact Or.inl (h.landed_on_journal hl)
    · exact Or.inr (by simp [hl])
  | crash _ _ =>
    refine ⟨by intro e; simp at e, h.closed_known, by intro e; simp at e, ?_⟩
    intro hj
    have hj : d.stopped = true := hj
    have hr := h.journal_not_running hj
    simp [hj, hr]

theorem stop_inv_reach {d : Driver} (r : Reach d) : StopInv d := by
  induction r with
  | init n => exact stop_inv_init n
  | step _ s ih => exact stop_inv_step ih s

/-- **F8.** A stop the host let go of is on the journal, or the host heard that it is not: close waits for the stop's
    commit and throws it when the store refused it. -/
theorem stop_on_journal_or_heard {d : Driver} (r : Reach d) (h : d.told = true ∧ d.closed = true) :
    d.stopped = true ∨ d.heard = true :=
  (stop_inv_reach r).closed_known h.2

/-- **F9.** A run with a stop applied, or whose journal holds its stop, admits nothing and settles nothing: every step
    that changes an effect on the journal needs a running run. -/
theorem stop_admits_nothing {d d' : Driver} (r : Reach d) (h : d.stop ≠ .none ∨ d.stopped = true) (s : Step d d') :
    d'.memo = d.memo := by
  have inv := stop_inv_reach r
  have hr : d.run ≠ .running := by
    rcases h with h | h
    · exact inv.applied_not_running h
    · exact inv.journal_not_running h
  cases s with
  | admit hrun _ _ _ _ => exact absurd hrun hr
  | dispatch _ _ _ => rfl
  | settle hrun _ => exact absurd hrun hr
  | lost _ _ => rfl
  | answer _ _ _ _ _ => rfl
  | refuse _ _ _ _ => rfl
  | finish _ _ => rfl
  | fail => rfl
  | cancel _ _ => rfl
  | commitStop _ => rfl
  | stopRefused _ => rfl
  | close _ _ => rfl
  | crash _ _ => rfl

/-- **F9b.** A run with a stop applied, or whose journal holds its stop, dispatches nothing: an admitted effect does not
    go out after a stop. The driver's guard throws the stop before a dispatch, not only before an admission. -/
theorem stop_dispatches_nothing {d d' : Driver} (r : Reach d) (h : d.stop ≠ .none ∨ d.stopped = true) (s : Step d d') :
    d'.sent = d.sent := by
  have inv := stop_inv_reach r
  have hr : d.run ≠ .running := by
    rcases h with h | h
    · exact inv.applied_not_running h
    · exact inv.journal_not_running h
  cases s with
  | admit hrun _ _ _ _ => exact absurd hrun hr
  | dispatch hrun _ _ => exact absurd hrun hr
  | settle hrun _ => exact absurd hrun hr
  | lost _ _ => rfl
  | answer _ _ _ _ _ => rfl
  | refuse _ _ _ _ => rfl
  | finish _ _ => rfl
  | fail => rfl
  | cancel _ _ => rfl
  | commitStop _ => rfl
  | stopRefused _ => rfl
  | close _ _ => rfl
  | crash _ _ => rfl

/-- A stop the journal holds stays held, whatever step follows. -/
theorem stopped_step {d d' : Driver} (s : Step d d') (h : d.stopped = true) : d'.stopped = true := by
  cases s <;> first | exact h | rfl

/-- A state some steps reach from a reachable one is reachable. -/
theorem reach_steps {d d' : Driver} (r : Reach d) (p : Steps d d') : Reach d' := by
  induction p with
  | refl => exact r
  | tail _ s ih => exact Reach.step ih s

/-- **F10.** A cancelled run never resumes: once the journal holds the stop, no later step, crash or restart changes an
    effect on the journal. -/
theorem cancelled_never_resumes {d d' : Driver} (r : Reach d) (h : d.stopped = true) (p : Steps d d') :
    d'.memo = d.memo := by
  have key : d'.memo = d.memo ∧ d'.stopped = true := by
    induction p with
    | refl => exact ⟨rfl, h⟩
    | tail p1 s ih => exact ⟨(stop_admits_nothing (reach_steps r p1) (Or.inr ih.2) s).trans ih.1, stopped_step s ih.2⟩
  exact key.1

/-- **F11.** A refused stop commit is reached and heard: the host is told of a stop, the store refuses its commit, and
    close throws it. `stop_on_journal_or_heard` covers that state, not only states where the stop landed. -/
theorem stop_refused_heard : ∃ d, Reach d ∧ d.told = true ∧ d.closed = true ∧ d.stopped = false ∧ d.heard = true := by
  let d0 := init 1
  have r1 := Reach.step (Reach.init 1) (Step.cancel d0 rfl rfl)
  have r2 := Reach.step r1 (Step.stopRefused _ rfl)
  have r3 := Reach.step r2 (Step.close _ (Or.inr rfl) rfl)
  exact ⟨_, r3, rfl, rfl, rfl, by simp⟩

end Frozen
end AgentRunRecovery
