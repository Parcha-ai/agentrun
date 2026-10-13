/-!
# The record gate (`packages/pi/src/durable/record.ts`)

A node delivers its record through one `submit` tool. A submit that passes the structural checks
meets the second reading: one answer per reviewer (the host's own reviewers and the node's verify
clause). The reading is feedback, once per node run: the first record it disagrees with goes back
(`bounce`, one of the delivery attempts); every later record is delivered (`accept`), with what the
reading still disagrees with beside it. A reviewer that got no answer (`noVerdict`: it threw, or
it has no route to ask on) never disagrees: the gate fails open.

A submit the structural checks refuse is `rejected`. Every answer the node gets that is not a
delivery spends one of its delivery attempts (`DELIVERY_ATTEMPTS`), counted once on the record
state's `attempts`: a rejection, the bounce, and a yield without a record (the nudge). Once they
are spent the node's run ends.

`gate` and `step` below are `gate` and `spend` in the TypeScript core.

- `no_verdict_never_disagrees`: a `noVerdict` answer never disagrees.
- `gate_ignores_no_verdict`: `noVerdict` answers added to any list leave the gate's outcome unchanged.
- `no_verdict_never_bounces`: answers that are all `noVerdict` never send the record back.
- `after_round_accepts`: once the round was had, every gated submit is accepted, whatever the
  answers.
- `gate_terminates`: for any reviewer, the run's gated submits end in `accept` within two submits.
- `step_counts_once`: every answer before the run ends spends exactly one attempt.
- `attempts_bounded`: the one counter never passes the budget.
- `session_terminates`: whatever the model sends, a run has ended (delivered or out of attempts)
  after as many answers as the budget holds.
-/

namespace AgentRunEnvelope
namespace Gate

/-- One reviewer's reading of a structurally valid record (`Reading` in the TypeScript core). -/
inductive Answer where
  | disagrees | agrees | noVerdict
  deriving DecidableEq, Repr

/-- The gate's disagreement: a reviewer that objects to the record. -/
def disagrees (a : Answer) : Bool :=
  a == .disagrees

/-- One gated submit and its answers. -/
structure Submit where
  answers : List Answer
  deriving Repr

inductive Outcome where
  | accept | bounce
  deriving DecidableEq, Repr

/-- The gate on one structurally valid submit: `bounced` says whether the round was had. -/
def gate (bounced : Bool) (s : Submit) : Outcome :=
  if !bounced && s.answers.any disagrees then .bounce else .accept

/-- **G1.** A `noVerdict` answer never disagrees. -/
theorem no_verdict_never_disagrees (a : Answer) (h : a = .noVerdict) : disagrees a = false := by
  simp [disagrees, h]

/-- **G1'.** Adding `noVerdict` answers to any list leaves the gate's outcome as it was. -/
theorem gate_ignores_no_verdict (b : Bool) (as us : List Answer) (h : ∀ u ∈ us, u = .noVerdict) :
    gate b { answers := as ++ us } = gate b { answers := as } := by
  have none : us.any disagrees = false := by
    rw [List.any_eq_false]
    intro u hu
    simp [no_verdict_never_disagrees u (h u hu)]
  simp [gate, List.any_append, none]

/-- **G1''.** Answers that are all `noVerdict` never bounce the record. -/
theorem no_verdict_never_bounces (b : Bool) (s : Submit) (h : ∀ a ∈ s.answers, a = .noVerdict) :
    gate b s ≠ .bounce := by
  have none : s.answers.any disagrees = false := by
    rw [List.any_eq_false]
    intro a ha
    simp [no_verdict_never_disagrees a (h a ha)]
  simp [gate, none]

/-- **G2.** Once the round was had, every gated submit is accepted, whatever its answers. -/
theorem after_round_accepts (s : Submit) : gate true s = .accept := by
  simp [gate]

/-- **G3.** For any reviewer (any answers on any submit), the run's gated submits end in `accept`
    within two: the first submit bounces or is accepted, and a submit after the bounce is accepted. -/
theorem gate_terminates (first second : Submit) :
    gate false first = .accept ∨ (gate false first = .bounce ∧ gate true second = .accept) := by
  cases h : gate false first
  · exact Or.inl rfl
  · exact Or.inr ⟨rfl, after_round_accepts second⟩

/-- The delivery attempts a node's run gets by default: `DELIVERY_ATTEMPTS` in the TypeScript core. -/
def deliveryAttempts : Nat := 6

/-- What the node's model does next: a submit the structural checks refuse, a structurally valid
    submit the gate reads, or a yield without a record. -/
inductive Event where
  | rejected
  | gated (s : Submit)
  | yielded
  deriving Repr

/-- The run's delivery state: the record state's `attempts`, the gate state's `bounced`, and whether a
    record is held. -/
structure State where
  attempts : Nat := 0
  bounced : Bool := false
  delivered : Bool := false
  deriving Repr

/-- A run has ended: its record is delivered, or its attempts are spent. -/
def State.ended (max : Nat) (σ : State) : Prop := σ.delivered = true ∨ max ≤ σ.attempts

instance (max : Nat) (σ : State) : Decidable (σ.ended max) := by
  unfold State.ended; infer_instance

/-- One answer: an ended run takes no more; otherwise each answer spends one attempt. -/
def step (max : Nat) (σ : State) (e : Event) : State :=
  if σ.ended max then σ else
  match e with
  | .rejected => { σ with attempts := σ.attempts + 1 }
  | .yielded => { σ with attempts := σ.attempts + 1 }
  | .gated s =>
    match gate σ.bounced s with
    | .bounce => { σ with attempts := σ.attempts + 1, bounced := true }
    | .accept => { σ with attempts := σ.attempts + 1, delivered := true }

/-- The run after a sequence of answers. -/
def run (max : Nat) (σ : State) (es : List Event) : State := es.foldl (step max) σ

/-- **G4.** Every answer before the run ends spends exactly one attempt: one counter. -/
theorem step_counts_once (max : Nat) (σ : State) (e : Event) (h : ¬ σ.ended max) :
    (step max σ e).attempts = σ.attempts + 1 := by
  unfold step
  rw [if_neg h]
  cases e with
  | rejected => rfl
  | yielded => rfl
  | gated s => cases hg : gate σ.bounced s <;> simp [hg]

private theorem ended_stays (max : Nat) (σ : State) (es : List Event) (h : σ.ended max) :
    (run max σ es).ended max := by
  induction es generalizing σ with
  | nil => exact h
  | cons e es ih =>
    show (run max (step max σ e) es).ended max
    have : step max σ e = σ := by unfold step; rw [if_pos h]
    rw [this]; exact ih σ h

private theorem progress (max : Nat) (σ : State) (es : List Event) :
    (run max σ es).ended max ∨ (run max σ es).attempts = σ.attempts + es.length := by
  induction es generalizing σ with
  | nil => exact Or.inr (by simp [run])
  | cons e es ih =>
    show (run max (step max σ e) es).ended max ∨ (run max (step max σ e) es).attempts = σ.attempts + (es.length + 1)
    by_cases h : σ.ended max
    · have : step max σ e = σ := by unfold step; rw [if_pos h]
      rw [this]; exact Or.inl (ended_stays max σ es h)
    · rcases ih (step max σ e) with done | count
      · exact Or.inl done
      · rw [count, step_counts_once max σ e h]; exact Or.inr (by omega)

/-- **G5.** The one counter never passes the budget. -/
theorem attempts_bounded (max : Nat) (es : List Event) : (run max {} es).attempts ≤ max := by
  suffices ∀ σ : State, σ.attempts ≤ max → (run max σ es).attempts ≤ max from this {} (Nat.zero_le _)
  induction es with
  | nil => intro σ h; exact h
  | cons e es ih =>
    intro σ h
    show (run max (step max σ e) es).attempts ≤ max
    apply ih
    by_cases hd : σ.ended max
    · have : step max σ e = σ := by unfold step; rw [if_pos hd]
      rw [this]; exact h
    · rw [step_counts_once max σ e hd]
      simp only [State.ended, not_or] at hd
      omega

/-- **G6.** Whatever the model sends (any rejections, any answers, any yields), a run has ended,
    its record delivered or its attempts spent, once it has had as many answers as the budget holds. -/
theorem session_terminates (es : List Event) (h : deliveryAttempts ≤ es.length) :
    (run deliveryAttempts {} es).ended deliveryAttempts := by
  rcases progress deliveryAttempts {} es with done | count
  · exact done
  · exact Or.inr (by rw [count]; simpa using h)

end Gate
end AgentRunEnvelope
