import AgentRunSemantics.Lemmas

/-!
# T3: loops are bounded and every run terminates

`eval` is a structurally recursive Lean function (no `partial`, no fuel): the kernel has
checked that it terminates on every node, state and oracle. A loop's only fuel is its
declared `maxIters`. The theorems below make the bound observable:

* `T3_loop_ignores_late_iterations`: a loop's result does not depend on what its body
  would do at any iteration index `≥ maxIters`, so no such iteration runs;
* `T3_loop_exit_count`: when `until` holds, it held after iteration `n`, `1 ≤ n ≤ maxIters`;
* `T3_loop_events`: every event of a loop is its own exit event or lies under
  `iterations/j` for some `j < maxIters`;
* `T3_runWorkflow_total`: every run returns `complete`, `escalated` or `failed`.
-/

namespace AgentRun


theorem stepWrap_events (O : Oracle) (b : Bool) (ctx : Ctx) (r : Run) :
    ∀ e ∈ (stepWrap O b ctx r).2, e ∈ r.2 ∨ e.path = ctx.path := by
  intro e he
  obtain ⟨o, ev⟩ := r
  cases b with
  | false => exact Or.inl he
  | true =>
    simp only [stepWrap, if_true] at he
    cases o with
    | ok s =>
      cases hA : O.afterNode with
      | none =>
        simp only [hA, List.cons_append, List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at he
        rcases he with rfl | he | rfl
        · exact Or.inr rfl
        · exact Or.inl he
        · exact Or.inr rfl
      | some f =>
        simp only [hA] at he
        split at he <;>
        · simp only [List.cons_append, List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at he
          rcases he with rfl | he | rfl
          · exact Or.inr rfl
          · exact Or.inl he
          · exact Or.inr rfl
    | escalated x | failed x =>
      simp only [List.cons_append, List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at he
      rcases he with rfl | he | rfl
      · exact Or.inr rfl
      · exact Or.inl he
      · exact Or.inr rfl

theorem loopRun_congr (body body' : Nat → State → Run) (u : Nat → State → Except Err Bool) :
    ∀ (n i : Nat) (s : State), (∀ j, j < i + n → body j = body' j) →
      loopRun body u n i s = loopRun body' u n i s
  | 0, _, _, _ => rfl
  | k + 1, i, s, h => by
    have ih := fun s => loopRun_congr body body' u k (i + 1) s (fun j hj => h j (by omega))
    simp only [loopRun, h i (by omega), ih]

theorem loopRun_exit_bounds (body : Nat → State → Run) (u : Nat → State → Except Err Bool) :
    ∀ (n i : Nat) (s : State) (r : Nat), (loopRun body u n i s).2.2 = some r → i < r ∧ r ≤ i + n
  | 0, _, _, _, h => by simp [loopRun] at h
  | k + 1, i, s, r, h => by
    simp only [loopRun] at h
    rcases hb : body i s with ⟨o1, ev1⟩
    rw [hb] at h
    cases o1 with
    | ok s' =>
      simp only at h
      rcases hu : u i s' with e | c
      · rw [hu] at h; simp at h
      · rw [hu] at h
        cases c with
        | true => simp only [Option.some.injEq] at h; omega
        | false =>
          have := loopRun_exit_bounds body u k (i + 1) s' r h
          omega
    | escalated _ | failed _ => simp at h

theorem loopRun_events (body : Nat → State → Run) (u : Nat → State → Except Err Bool) (Q : Nat → Event → Prop)
    (hb : ∀ j st, ∀ e ∈ (body j st).2, Q j e) :
    ∀ (n i : Nat) (s : State), ∀ e ∈ (loopRun body u n i s).2.1, ∃ j, i ≤ j ∧ j < i + n ∧ Q j e
  | 0, _, _, e, he => by simp [loopRun] at he
  | k + 1, i, s, e, he => by
    simp only [loopRun] at he
    have hbi := hb i s
    rcases h1 : body i s with ⟨o1, ev1⟩
    rw [h1] at he hbi
    cases o1 with
    | ok s' =>
      simp only at he
      rcases hu : u i s' with x | c
      · rw [hu] at he; exact ⟨i, Nat.le_refl _, by omega, hbi e he⟩
      · rw [hu] at he
        cases c with
        | true => exact ⟨i, Nat.le_refl _, by omega, hbi e he⟩
        | false =>
          simp only [List.mem_append] at he
          rcases he with he | he
          · exact ⟨i, Nat.le_refl _, by omega, hbi e he⟩
          · obtain ⟨j, h1, h2, h3⟩ := loopRun_events body u Q hb k (i + 1) s' e he
            exact ⟨j, by omega, by omega, h3⟩
    | escalated _ | failed _ => exact ⟨i, Nat.le_refl _, by omega, hbi e he⟩

theorem prefix_append_right {α} (p q r : List α) (h : p ++ q <+: r) : p <+: r :=
  List.IsPrefix.trans (List.prefix_append p q) h

theorem runItems_events (f : Nat → Value → Run) (P : Event → Prop) (hf : ∀ i x, ∀ e ∈ (f i x).2, P e) :
    ∀ (i : Nat) (xs : List Value), ∀ e ∈ ((runItems f i xs).map (·.2)).flatten, P e
  | _, [], e, he => by simp [runItems] at he
  | i, x :: xs, e, he => by
    simp only [runItems, List.map_cons, List.flatten_cons, List.mem_append] at he
    rcases he with he | he
    · exact hf i x e he
    · exact runItems_events f P hf (i + 1) xs e he

set_option hygiene false in
/-- Close `e ∈ (match … with … => (_, [])).2` goals: every branch has no events. -/
macro "no_events" : tactic => `(tactic| ((repeat' split at he) <;> simp at he))

mutual
theorem eval_events (O : Oracle) : ∀ (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    ∀ e ∈ (eval O n path addr lp s).2, path <+: e.path
  | .chain steps, path, addr, lp, s => by
    simp only [eval]; exact evalChain_events O steps 0 path addr lp s
  | .code .., path, addr, lp, s
  | .gen .., path, addr, lp, s
  | .judge .., path, addr, lp, s
  | .pick .., path, addr, lp, s
  | .sift .., path, addr, lp, s
  | .call .., path, addr, lp, s => by
    simp only [eval]; intro e he
    rcases stepWrap_events _ _ _ _ e he with he | he
    · no_events
    · exact he ▸ List.prefix_refl _
  | .report .., path, addr, lp, s => by
    simp only [eval, evalReport]; intro e he
    rcases stepWrap_events _ _ _ _ e he with he | he
    · no_events
    · exact he ▸ List.prefix_refl _
  | .artifact label type fpath requires st, path, addr, lp, s => by
    simp only [eval]; intro e he
    split at he
    · simp only [evalReport] at he
      rcases stepWrap_events _ _ _ _ e he with he | he
      · no_events
      · exact he ▸ List.prefix_refl _
    · rcases stepWrap_events _ _ _ _ e he with he | he
      · no_events
      · exact he ▸ List.prefix_refl _
  | .map label itemsPath body as resultPath, path, addr, lp, s => by
    simp only [eval]; intro e he
    split at he
    · rename_i items _
      have hall := runItems_events _ (fun e => path <+: e.path)
        (fun i x e he => prefix_append_right _ _ _
          (eval_events O body (path ++ ["items", seg i, "body"]) (addr ++ [.body]) lp
            ((s.set "item" x).set "item_index" (.num i)) e he)) 0 items
      split at he <;> exact hall e he
    · simp at he
  | .parallel label branches, path, addr, lp, s => by
    simp only [eval]; intro e he
    have := evalBranches_events O branches 0 path addr lp s
    split at he <;> exact this e he
  | .loop label body u maxIters, path, addr, lp, s => by
    have hl := loopRun_events
      (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u)
      (fun _ e => path <+: e.path)
      (fun j st e he => prefix_append_right _ _ _ (eval_events O body _ _ lp st e he)) maxIters 0 s
    simp only [eval]; intro e he
    rcases hr : loopRun (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u) maxIters 0 s with ⟨o, ev, x⟩
    rw [hr] at hl he
    cases o with
    | ok s' =>
      cases x <;>
      · simp only [List.mem_append, List.mem_singleton] at he
        rcases he with he | rfl
        · obtain ⟨j, _, _, hj⟩ := hl e he; exact hj
        · exact List.prefix_refl _
    | escalated _ | failed _ => obtain ⟨j, _, _, hj⟩ := hl e he; exact hj
  | .escalate .., path, addr, lp, s => by
    simp only [eval]; intro e he
    split at he
    · simp at he
    · split at he <;>
      · simp only [List.mem_singleton] at he; subst he; exact List.prefix_refl _
  | .route label st branches unsure as requires, path, addr, lp, s => by
    simp only [eval]; intro e he
    rcases h1 : checkRequires label addr s requires with x | _
    · simp [h1] at he
    simp only [h1] at he
    rcases h2 : promptState label s (some st) with x | asked
    · simp [h2] at he
    simp only [h2] at he
    rcases h3 : O.route ⟨path, lp ++ label⟩ asked with x | ⟨choice, conf, sidecar⟩
    · simp [h3] at he
    simp only [h3] at he
    split at he
    · simp at he
    · split at he
      · next o ev' heq =>
        simp only [List.mem_append, List.mem_singleton] at he
        rcases he with rfl | he
        · exact List.prefix_refl _
        · exact evalNamed_events O branches _ path addr lp _ _ heq e he
      · simp only [List.mem_singleton] at he; subst he; exact List.prefix_refl _
  | .workflow label child root input out as, path, addr, lp, s => by
    simp only [eval]; intro e he
    rcases stepWrap_events _ _ _ _ e he with he | he
    · rcases h1 : interpFields s input with p | childInput
      · simp [h1] at he
      simp only [h1] at he
      have hc := eval_events O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") childInput
      rcases hr : eval O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") childInput with ⟨o, ev⟩
      rw [hr] at hc he
      have hc' : ∀ e ∈ ev, path <+: e.path := fun e he => prefix_append_right _ _ _ (hc e he)
      cases o <;> simp only at he <;> (repeat' split at he) <;> first | (simp at he; done) | exact hc' e he
    · exact he ▸ List.prefix_refl _

theorem evalChain_events (O : Oracle) : ∀ (steps : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    ∀ e ∈ (evalChain O steps i path addr lp s).2, path <+: e.path
  | [], _, _, _, _, _ => by simp [evalChain]
  | n :: ns, i, path, addr, lp, s => by
    simp only [evalChain]
    have hn := eval_events O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s
    intro e he
    rcases hr : eval O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s with ⟨o, ev⟩
    rw [hr] at hn he
    cases o with
    | ok s' =>
      simp only [List.mem_append] at he
      rcases he with he | he
      · exact prefix_append_right _ _ _ (hn e he)
      · exact evalChain_events O ns (i + 1) path addr lp s' e he
    | escalated _ | failed _ => exact prefix_append_right _ _ _ (hn e he)

theorem evalBranches_events (O : Oracle) : ∀ (bs : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    ∀ e ∈ ((evalBranches O bs i path addr lp s).map (·.2)).flatten, path <+: e.path
  | [], _, _, _, _, _ => by simp [evalBranches]
  | b :: bs, i, path, addr, lp, s => by
    simp only [evalBranches, List.map_cons, List.flatten_cons, List.mem_append]
    intro e he
    rcases he with he | he
    · exact prefix_append_right _ _ _ (eval_events O b _ _ lp s e he)
    · exact evalBranches_events O bs (i + 1) path addr lp s e he

theorem evalNamed_events (O : Oracle) : ∀ (bs : List (String × Node)) (taken : String) (path : ExecPath) (addr : Addr) (lp : String) (s : State) (r : Run),
    evalNamed O bs taken path addr lp s = some r → ∀ e ∈ r.2, path <+: e.path
  | [], _, _, _, _, _, _, h => by simp [evalNamed] at h
  | (name, b) :: rest, taken, path, addr, lp, s, r, h => by
    simp only [evalNamed] at h
    split at h
    · simp only [Option.some.injEq] at h; subst h
      intro e he; exact prefix_append_right _ _ _ (eval_events O b _ _ lp s e he)
    · exact evalNamed_events O rest taken path addr lp s r h
end

/-- **T3a.** A loop never runs an iteration at index `≥ maxIters`: its result is the same
for any two bodies that agree below the bound. -/
theorem T3_loop_ignores_late_iterations (body body' : Nat → State → Run) (u : Nat → State → Except Err Bool)
    (maxIters : Nat) (s : State) (h : ∀ j, j < maxIters → body j = body' j) :
    loopRun body u maxIters 0 s = loopRun body' u maxIters 0 s :=
  loopRun_congr body body' u maxIters 0 s (by simpa using h)

/-- **T3b.** When `until` holds, it held after iteration `n`, `1 ≤ n ≤ maxIters`. -/
theorem T3_loop_exit_count (body : Nat → State → Run) (u : Nat → State → Except Err Bool)
    (maxIters : Nat) (s : State) (n : Nat)
    (h : (loopRun body u maxIters 0 s).2.2 = some n) : 1 ≤ n ∧ n ≤ maxIters := by
  have := loopRun_exit_bounds body u maxIters 0 s n h; omega

/-- **T3c.** For every oracle, every event of a loop node is its own exit event or lies
under `iterations/j` with `j < maxIters`. -/
theorem T3_loop_events (O : Oracle) (label : String) (body : Node) (u : Pred) (maxIters : Nat)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State) :
    ∀ e ∈ (eval O (.loop label body u maxIters) path addr lp s).2,
      e.path = path ∨ ∃ j, j < maxIters ∧ (path ++ ["iterations", seg j]) <+: e.path := by
  have hl := loopRun_events
    (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
    (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u)
    (fun j e => (path ++ ["iterations", seg j]) <+: e.path)
    (fun j st e he => by
      have := eval_events O body (path ++ ["iterations", seg j, "body"]) (addr ++ [.body]) lp st e he
      exact List.IsPrefix.trans ⟨["body"], by simp⟩ this) maxIters 0 s
  simp only [eval]; intro e he
  rcases hr : loopRun (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
    (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u) maxIters 0 s with ⟨o, ev, x⟩
  rw [hr] at hl he
  cases o with
  | ok s' =>
    cases x <;>
    · simp only [List.mem_append, List.mem_singleton] at he
      rcases he with he | rfl
      · obtain ⟨j, _, hj, hp⟩ := hl e he; exact Or.inr ⟨j, by omega, hp⟩
      · exact Or.inl rfl
  | escalated _ | failed _ =>
    obtain ⟨j, _, hj, hp⟩ := hl e he; exact Or.inr ⟨j, by omega, hp⟩

/-- **T3d.** Every run of every workflow, for every oracle and input, ends in one of the
three terminal outcomes. The content is that `runWorkflow` is a total function: `eval`
is accepted by the kernel as structural recursion, and a loop's fuel is its `maxIters`. -/
theorem T3_runWorkflow_total (O : Oracle) (wf : Workflow) (input : State) :
    (∃ s, (runWorkflow O wf input).outcome = .ok s) ∨
    (∃ e, (runWorkflow O wf input).outcome = .escalated e) ∨
    (∃ e, (runWorkflow O wf input).outcome = .failed e) := by
  cases (runWorkflow O wf input).outcome with
  | ok s => exact Or.inl ⟨s, rfl⟩
  | escalated e => exact Or.inr (Or.inl ⟨e, rfl⟩)
  | failed e => exact Or.inr (Or.inr ⟨e, rfl⟩)

end AgentRun
