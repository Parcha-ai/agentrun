import AgentRunSemantics.Theorems.Requires
import AgentRunSemantics.Theorems.Parallel

/-!
# Findings: where the stated claims are false

Each finding is a concrete workflow and oracle, evaluated by the kernel (`decide +kernel`
or `rfl`, no `native_decide`). Every one has a TypeScript twin in `spec/lean/conformance/`
that the interpreter runs with the same outcome, so the counterexample is about the code,
not only the model.
-/

namespace AgentRun

mutual
theorem Value.eq_of_structEq : ∀ a b : Value, Value.structEq a b = true → a = b
  | .null, .null, _ => rfl
  | .bool x, .bool y, h => by simp [Value.structEq] at h; rw [h]
  | .num x, .num y, h => by simp [Value.structEq] at h; rw [h]
  | .str x, .str y, h => by simp [Value.structEq] at h; rw [h]
  | .arr xs, .arr ys, h => by simp only [Value.structEq] at h; rw [Value.eq_of_structEqList xs ys h]
  | .obj xs, .obj ys, h => by simp only [Value.structEq] at h; rw [Value.eq_of_structEqFields xs ys h]
  | .null, .bool _, h | .null, .num _, h | .null, .str _, h | .null, .arr _, h | .null, .obj _, h
  | .bool _, .null, h | .bool _, .num _, h | .bool _, .str _, h | .bool _, .arr _, h | .bool _, .obj _, h
  | .num _, .null, h | .num _, .bool _, h | .num _, .str _, h | .num _, .arr _, h | .num _, .obj _, h
  | .str _, .null, h | .str _, .bool _, h | .str _, .num _, h | .str _, .arr _, h | .str _, .obj _, h
  | .arr _, .null, h | .arr _, .bool _, h | .arr _, .num _, h | .arr _, .str _, h | .arr _, .obj _, h
  | .obj _, .null, h | .obj _, .bool _, h | .obj _, .num _, h | .obj _, .str _, h | .obj _, .arr _, h => by
    simp [Value.structEq] at h
theorem Value.eq_of_structEqList : ∀ xs ys : List Value, Value.structEqList xs ys = true → xs = ys
  | [], [], _ => rfl
  | x :: xs, y :: ys, h => by
    simp only [Value.structEqList, Bool.and_eq_true] at h
    rw [Value.eq_of_structEq x y h.1, Value.eq_of_structEqList xs ys h.2]
  | [], _ :: _, h | _ :: _, [], h => by simp [Value.structEqList] at h
theorem Value.eq_of_structEqFields : ∀ xs ys : List (String × Value), Value.structEqFields xs ys = true → xs = ys
  | [], [], _ => rfl
  | (k, v) :: xs, (k', v') :: ys, h => by
    simp only [Value.structEqFields, Bool.and_eq_true, beq_iff_eq] at h
    rw [h.1.1, Value.eq_of_structEq v v' h.1.2, Value.eq_of_structEqFields xs ys h.2]
  | [], _ :: _, h | _ :: _, [], h => by simp [Value.structEqFields] at h
end

instance : DecidableEq Value := fun a b =>
  if h : Value.structEq a b = true then isTrue (Value.eq_of_structEq a b h)
  else isFalse (fun e => h (e ▸ Value.structEq_refl a))

deriving instance DecidableEq for Escalation, Err, Outcome

/-- A small oracle: every generative node submits `genOut`, code nodes return `codeOut`,
and a schema accepts `undefined` only when `acceptUndefined`. -/
def exampleOracle (codeOut : Ctx → Value) (genOut : Value) (acceptUndefined : Bool := false) : Oracle where
  code ctx _ := .ok (codeOut ctx)
  gen _ _ _ := .ok { value := genOut }
  report _ _ := .ok { value := .str "report" }
  judge _ _ := .ok (.obj [], .obj [])
  pick _ _ _ := .ok (none, .obj [])
  sift _ _ _ := .ok []
  route _ _ := .ok ("", 1, .obj [])
  effect _ _ := .ok (.obj [])
  ask _ _ := .ok 1
  schemaOk _ v := acceptUndefined || v.isSome
  afterNode := none
  render _ _ := ""
  questionLimit := 256
  choose l := l.headD (.ok [])
  choose_mem l h := by
    cases l with
    | nil => exact absurd rfl h
    | cons a t => simp [List.headD]

def hdr (name : String) (outputPath : Option Path := none) : Header :=
  { name, schemas := ["Any", "V", "Undef"], input := none, output := "Any", outputPath }

def agent (label : String) (as : Option String) (requires : List Path := []) : Node :=
  .gen .agent label "V" as requires none none

/-! ## F1: `validate` ok does not rule out `required_nonempty` -/

/-- `requires-after-code.json`: the validator stops tracking after a code node. -/
def wfRequiresAfterCode : Workflow :=
  ⟨hdr "req-after-code", .chain [.code "noop" none, agent "answer" (some "answer") [["missing"]]]⟩

/-- `requires-empty-submission.json`: a tracked head is present but empty. -/
def wfRequiresEmpty : Workflow :=
  ⟨hdr "req-empty", .chain [agent "draft" (some "draft"), agent "review" (some "review") [["draft"]]]⟩

/-- **T1 as stated is false.** There is an oracle, a validated workflow and an input whose
run fails `required_nonempty`. -/
theorem T1_as_stated_is_false : ¬ ∀ (O : Oracle) (wf : Workflow) (input : State),
    (validate wf (some input.keys)).ok = true →
      ∀ l a p hp, (runWorkflow O wf input).outcome ≠ .failed (.required l a p hp) := by
  intro h
  exact h (exampleOracle (fun _ => .obj []) (.obj [])) wfRequiresAfterCode [("q", .num 1)]
    (by decide +kernel) "answer" [.step 1] ["missing"] false (by decide +kernel)

/-- The first failure is outside what the validator checked (it stopped at the code node),
with an absent head; the oracle rejects `undefined`, so T1_requires_sound's hypotheses hold. -/
theorem F1_untracked_after_code :
    (validate wfRequiresAfterCode (some ["q"])).ok = true ∧
    [AddrSeg.step 1] ∉ (validate wfRequiresAfterCode (some ["q"])).checked ∧
    (runWorkflow (exampleOracle (fun _ => .obj []) (.obj [])) wfRequiresAfterCode [("q", .num 1)]).outcome =
      .failed (.required "answer" [.step 1] ["missing"] false) := by
  decide +kernel

/-- The second failure is at a node the validator did check: the head is present, but the
upstream agent submitted `{}`. Validation guarantees a producer, not a value. -/
theorem F1_tracked_but_empty :
    (validate wfRequiresEmpty (some ["q"])).ok = true ∧
    [AddrSeg.step 1] ∈ (validate wfRequiresEmpty (some ["q"])).checked ∧
    (runWorkflow (exampleOracle (fun _ => .obj []) (.obj [])) wfRequiresEmpty [("q", .num 1)]).outcome =
      .failed (.required "review" [.step 1] ["draft"] true) := by
  decide +kernel

/-! ## F2: parallel disjointness is checked on `declaredWrites`, which misses writes -/

def wfParallelCode : Workflow :=
  ⟨hdr "par-code", .parallel "both" [.code "c1" none, .code "c2" none]⟩

def wfParallelLabel : Workflow :=
  ⟨hdr "par-label", .parallel "both" [agent "x" none, .code "c" none]⟩

/-- `parallel-code-collision.json`: two unaliased code branches write `k`. -/
theorem F2_code_patches_collide :
    (validate wfParallelCode (some [])).ok = true ∧
    (runWorkflow (exampleOracle (fun ctx => .obj [("k", .str ctx.label)]) (.obj [])) wfParallelCode []).outcome =
      .failed (.state .parallelWriteConflict "both" ["k"]) := by
  decide +kernel

/-- `parallel-label-collision.json`: an unaliased agent writes under its label. -/
theorem F2_label_collides :
    (validate wfParallelLabel (some ["q"])).ok = true ∧
    (runWorkflow (exampleOracle (fun _ => .obj [("x", .num 1)]) (.obj [("v", .str "a")])) wfParallelLabel
      [("q", .num 1)]).outcome = .failed (.state .parallelWriteConflict "both" ["x"]) := by
  decide +kernel

/-! ## F3: an unaliased code node may write `$`-prefixed keys other than `$host` -/

def wfDollar : Workflow := ⟨hdr "dollar", .code "c" none⟩

/-- `code-writes-dollar-key.json`. -/
theorem F3_code_writes_dollar_key :
    (validate wfDollar (some [])).ok = true ∧
    (runWorkflow (exampleOracle (fun _ => .obj [("$other", .num 1)]) (.obj [])) wfDollar []).outcome =
      .ok [("$other", .num 1)] := by
  decide +kernel

/-! ## F4: a child invocation's input cannot name `$host` -/

def childHdr : Header := { name := "child", schemas := ["CIn", "Any2"], input := some "CIn", output := "Any2", outputPath := none }

def wfChildHost : Workflow :=
  ⟨hdr "parent-host", .workflow "w" childHdr (.code "k" none) [("$host", .ref ["q"])] "Any" "w"⟩

/-- `child-input-host.json`. -/
theorem F4_child_input_host :
    (validate wfChildHost (some ["q"])).ok = false := by
  decide +kernel

/-! ## F5: the `undefined` hypothesis of T1_requires_sound is necessary -/

def childUndefHdr : Header :=
  { name := "child", schemas := ["CIn", "CR", "CAny"], input := some "CIn", output := "CAny", outputPath := some ["r", "a"] }

def wfChildUndefined : Workflow :=
  ⟨hdr "parent-undef", .chain [
    .workflow "w" childUndefHdr (.gen .agent "r" "CR" (some "r") [] none none) [("question", .ref ["q"])] "Undef" "w",
    agent "b" (some "b") [["w"]]]⟩

/-- `child-undefined-output.json`: a permissive schema lets `undefined` land at the parent's
`as`, and a checked `requires` then fails with an absent head. -/
theorem F5_undefined_child_output :
    (validate wfChildUndefined (some ["q"])).ok = true ∧
    [AddrSeg.step 1] ∈ (validate wfChildUndefined (some ["q"])).checked ∧
    (runWorkflow (exampleOracle (fun _ => .obj []) (.obj []) (acceptUndefined := true)) wfChildUndefined
      [("q", .str "x")]).outcome = .failed (.required "b" [.step 1] ["w"] false) := by
  decide +kernel

/-! ## F6: T2 as stated ("a node writes only its `as` or label, plus `$host`") -/

/-- An unaliased code node writes the keys it returns, not its label; a judge also writes
`<as>$answers`. -/
theorem F6_writes_beyond_as_or_label :
    (eval (exampleOracle (fun _ => .obj [("other", .num 1)]) (.obj [])) (.code "c" none) ["root"] [] "" []).1 =
      .ok [("other", .num 1)] ∧
    (eval (exampleOracle (fun _ => .obj []) (.obj [])) (.judge "j" (.obj [("q", .lit .null)]) "Q" "j" [])
      ["root"] [] "" []).1 = .ok [("j", .obj []), ("j$answers", .obj [])] := by
  constructor <;> rfl

/-! ## F9 (fixed): predicates read state paths the way `requires` and interpolation do -/

/-- `predicate-array-index.json`: `scores.0` is 9 for `requires`, interpolation and the `gte`
predicate alike, so the gate fires. -/
theorem F9_fixed_predicate_indexes_arrays :
    getPathS [("scores", .arr [.num 9])] ["scores", "0"] = some (.num 9) ∧
    mechHolds (.obj [("scores", .arr [.num 9])]) (.gte ["scores", "0"] 5) = true := by
  decide +kernel

/-- The predicate reader is the state reader: one resolver, by definition. -/
theorem F9_fixed_one_resolver (v : Value) (p : Path) : getPathP v p = getPathV v p := rfl

end AgentRun
