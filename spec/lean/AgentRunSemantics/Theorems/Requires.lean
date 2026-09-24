import AgentRunSemantics.Lemmas
import AgentRunSemantics.Theorems.Writes

/-!
# T1: `requires` against what the validator checked

The claim under test: if `validateWorkflow` accepts, no node fails `assertNodeInputs`
(`required_nonempty`) for any oracle. That is false (see `Findings.lean`). What holds, and
is proven here: the validator tracks reachability only while it is knowable (before the
first `code`, `map`, `parallel`, `loop` or `route` on the walk, and afresh inside each child
workflow), checks only the first key of each `requires` path, and for every node it did
check, that first key is present when the node runs, for every oracle whose schema checks
reject `undefined`.

The proof threads the validator's `reachability` alongside the interpreter: `Covers`
states that every tracked key is in the state. Static addresses (`AddrSeg`) name nodes, and
sibling subtrees never share an address, so a failure inside one child can never be
attributed to a node the validator checked in another.
-/

namespace AgentRun

/-! ## Addresses: sibling subtrees never share an address -/

theorem prefix_clash {addr a : Addr} {x y : AddrSeg} (hx : (addr ++ [x]) <+: a) (hy : (addr ++ [y]) <+: a) : x = y := by
  have h := List.prefix_of_prefix_length_le hx hy (by simp)
  obtain ⟨t, ht⟩ := h
  have : t = [] := by
    have := congrArg List.length ht
    simp only [List.length_append, List.length_singleton] at this
    exact List.eq_nil_of_length_eq_zero (by omega)
  subst this
  simpa using ht

theorem prefix_trans_seg {addr a : Addr} {x : AddrSeg} (h : (addr ++ [x]) <+: a) : addr <+: a :=
  List.IsPrefix.trans (List.prefix_append _ _) h

theorem not_prefix_self_seg {addr : Addr} {x : AddrSeg} (h : (addr ++ [x]) <+: addr) : False := by
  have := h.length_le; simp at this; omega

/-! ## Where the validator records checked nodes -/

theorem checkedAt_prefix (avail : Option (List String)) (addr a : Addr) (h : a ∈ checkedAt avail addr) : a = addr := by
  unfold checkedAt at h; split at h <;> simp_all


mutual
theorem walk_checked : ∀ (n : Node) (addr : Addr) (env : VEnv) (a : Addr),
    a ∈ (walk n addr env).checked → addr <+: a
  | .chain steps, addr, env, a, h => by
    simp only [walk] at h
    obtain ⟨j, _, hj⟩ := walkList_checked steps 0 addr env a h
    exact prefix_trans_seg hj
  | .code .., _, _, _, h => by simp [walk] at h
  | .gen .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .report .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .artifact _ type .., addr, env, a, h => by
    simp only [walk] at h; split at h <;> (rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _)
  | .map _ _ body _ _, addr, env, a, h => by
    simp only [walk] at h; exact prefix_trans_seg (walk_checked body (addr ++ [.body]) _ a h)
  | .parallel _ bs, addr, env, a, h => by
    simp only [walk] at h
    obtain ⟨j, _, hj⟩ := walkBranches_checked bs 0 addr _ a h
    exact prefix_trans_seg hj
  | .loop _ body _ _, addr, env, a, h => by
    simp only [walk] at h; exact prefix_trans_seg (walk_checked body (addr ++ [.body]) _ a h)
  | .escalate .., _, _, _, h => by simp [walk] at h
  | .judge .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .pick .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .sift .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .route _ _ bs _ _ _, addr, env, a, h => by
    simp only [walk, List.mem_append] at h
    rcases h with h | h
    · rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
    · obtain ⟨name, _, hn⟩ := walkNamed_checked bs addr _ a h
      exact prefix_trans_seg hn
  | .dispatch _ _ bs _ _ _, addr, env, a, h => by
    simp only [walk, List.mem_append] at h
    rcases h with h | h
    · rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
    · obtain ⟨name, _, hn⟩ := walkNamed_checked bs addr _ a h
      exact prefix_trans_seg hn
  | .call .., addr, env, a, h => by simp only [walk] at h; rw [checkedAt_prefix _ _ _ h]; exact List.prefix_refl _
  | .workflow _ _ root _ _ _, addr, env, a, h => by
    simp only [walk, finishCore] at h
    exact prefix_trans_seg (walk_checked root (addr ++ [.child]) _ a h)
theorem walkList_checked : ∀ (ns : List Node) (i : Nat) (addr : Addr) (env : VEnv) (a : Addr),
    a ∈ (walkList ns i addr env).checked → ∃ j, i ≤ j ∧ (addr ++ [.step j]) <+: a
  | [], _, _, _, _, h => by simp [walkList] at h
  | n :: ns, i, addr, env, a, h => by
    simp only [walkList, List.mem_append] at h
    rcases h with h | h
    · exact ⟨i, Nat.le_refl _, walk_checked n _ env a h⟩
    · obtain ⟨j, hj, hp⟩ := walkList_checked ns (i + 1) addr _ a h
      exact ⟨j, by omega, hp⟩
theorem walkBranches_checked : ∀ (ns : List Node) (i : Nat) (addr : Addr) (env : VEnv) (a : Addr),
    a ∈ (walkBranches ns i addr env).checked → ∃ j, i ≤ j ∧ (addr ++ [.branch j]) <+: a
  | [], _, _, _, _, h => by simp [walkBranches] at h
  | n :: ns, i, addr, env, a, h => by
    simp only [walkBranches, List.mem_append] at h
    rcases h with h | h
    · exact ⟨i, Nat.le_refl _, walk_checked n _ env a h⟩
    · obtain ⟨j, hj, hp⟩ := walkBranches_checked ns (i + 1) addr _ a h
      exact ⟨j, by omega, hp⟩
theorem walkNamed_checked : ∀ (bs : List (String × Node)) (addr : Addr) (env : VEnv) (a : Addr),
    a ∈ (walkNamed bs addr env).checked → ∃ name ∈ branchNames bs, (addr ++ [.named name]) <+: a
  | [], _, _, _, h => by simp [walkNamed] at h
  | (name, n) :: rest, addr, env, a, h => by
    simp only [walkNamed, List.mem_append] at h
    rcases h with h | h
    · exact ⟨name, by simp [branchNames], walk_checked n _ env a h⟩
    · obtain ⟨nm, hnm, hp⟩ := walkNamed_checked rest addr _ a h
      exact ⟨nm, by simp [branchNames] at hnm ⊢; exact Or.inr hnm, hp⟩
end


/-! ## Coverage: every tracked key is present in the state -/

def Covers (avail : Option (List String)) (s : State) : Prop := ∀ L, avail = some L → ∀ k ∈ L, s.has k

theorem covers_none (s : State) : Covers none s := by intro L h; cases h

theorem covers_mono {avail : Option (List String)} {s s' : State} (hc : Covers avail s)
    (hm : ∀ k, s.has k → s'.has k) : Covers avail s' := fun L hL k hk => hm k (hc L hL k hk)

theorem covers_add {avail : Option (List String)} {s s' : State} (ks : List String) (hc : Covers avail s)
    (hm : ∀ k, s.has k → s'.has k) (hks : ∀ k ∈ ks, s'.has k) : Covers (addAvail avail ks) s' := by
  intro L hL k hk
  cases avail with
  | none => simp [addAvail] at hL
  | some A =>
    simp only [addAvail, Option.map_some, Option.some.injEq] at hL; subst hL
    rcases List.mem_append.mp hk with hk | hk
    · exact hm k (hc A rfl k hk)
    · exact hks k hk

theorem withHost_has (s : State) (h : List (String × Value)) (k : String) (hk : s.has k) : (withHost s h).has k := by
  unfold withHost; split
  · exact hk
  · exact State.has_set _ _ _ _ hk

theorem has_of_get (s : State) (k : String) (v : Value) (h : s.get k = some v) : s.has k := by
  simp [State.has, h]

/-! ## The only `required` failure a node raises itself is its own `requires` gate -/

theorem checkRequires_error (label : String) (addr : Addr) (s : State) :
    ∀ (reqs : List Path) (e : Err), checkRequires label addr s reqs = .error e →
      ∃ p ∈ reqs, e = .required label addr p (headPresent s p)
  | [], _, h => by simp [checkRequires] at h
  | p :: ps, e, h => by
    simp only [checkRequires] at h
    split at h
    · split at h
      · obtain ⟨q, hq, rfl⟩ := checkRequires_error label addr s ps e h
        exact ⟨q, List.mem_cons_of_mem _ hq, rfl⟩
      · simp only [Except.error.injEq] at h; exact ⟨p, List.mem_cons_self .., h.symm⟩
    · simp only [Except.error.injEq] at h; exact ⟨p, List.mem_cons_self .., h.symm⟩

/-- A node's own `requires` failure is at its own address, and never with an absent head
when the validator tracked it. -/
theorem own_requires (label : String) (addr : Addr) (s : State) (reqs : List Path) (avail : Option (List String))
    (hc : Covers avail s) (herr : requiresErrors avail reqs = []) (e : Err)
    (h : checkRequires label addr s reqs = .error e) (l : String) (a : Addr) (p : Path)
    (he : e = .required l a p false) : a = addr ∧ a ∉ checkedAt avail addr := by
  obtain ⟨q, hq, rfl⟩ := checkRequires_error label addr s reqs e h
  simp only [Err.required.injEq] at he
  obtain ⟨-, rfl, rfl, hhp⟩ := he
  refine ⟨rfl, ?_⟩
  cases avail with
  | none => simp [checkedAt]
  | some A =>
    exfalso
    simp only [requiresErrors, List.filterMap_eq_nil_iff] at herr
    have hA := herr q hq
    simp only [ite_eq_left_iff, reduceCtorEq, imp_false, Decidable.not_not] at hA
    cases q with
    | nil => simp [headPresent] at hhp
    | cons k _ =>
      simp only [headPresent] at hhp
      have := hc A rfl k (by simpa [headOf] using hA)
      rw [this] at hhp; exact absurd hhp (by simp)

theorem stepWrap_required (O : Oracle) (b : Bool) (ctx : Ctx) (r : Run) (e : Err)
    (h : (stepWrap O b ctx r).1 = .failed e) :
    r.1 = .failed e ∨ e = .state .reservedStateKey ctx.label [hostKey] := by
  obtain ⟨o, ev⟩ := r
  cases b with
  | false => left; simpa [stepWrap] using h
  | true =>
    simp only [stepWrap, if_true] at h
    cases o with
    | ok s =>
      cases hA : O.afterNode with
      | none => simp [hA] at h
      | some f =>
        simp only [hA] at h
        split at h
        · simp only [Outcome.failed.injEq] at h; right; exact h.symm
        · simp at h
    | escalated _ => simp at h
    | failed x => simp only [Outcome.failed.injEq] at h; left; simp [h]


theorem State.has_set_iff (s : State) (k k' : String) (v : Value) : (s.set k v).has k' = (k == k' || s.has k') := by
  simp only [State.has, State.get_set]
  by_cases h : k = k' <;> simp [h]

theorem withHost_has_iff (s : State) (h : List (String × Value)) (k : String) :
    (withHost s h).has k = ((!h.isEmpty && hostKey == k) || s.has k) := by
  unfold withHost
  cases h with
  | nil => simp
  | cons x xs => simp [State.has_set_iff]

theorem runItems_mem (f : Nat → Value → Run) : ∀ (i : Nat) (xs : List Value) (r : Run),
    r ∈ runItems f i xs → ∃ j x, r = f j x
  | _, [], _, h => by simp [runItems] at h
  | i, x :: xs, r, h => by
    simp only [runItems, List.mem_cons] at h
    rcases h with rfl | h
    · exact ⟨i, x, rfl⟩
    · exact runItems_mem f (i + 1) xs r h

theorem gather_error' (O : Oracle) (rs : List Outcome) (o : Outcome) (h : gather O rs = .error o) :
    o ∈ rs ∧ o.isOk = false := by
  unfold gather at h
  dsimp only at h
  split at h
  · simp at h
  · rename_i hne
    simp only [Except.error.injEq] at h
    have hmem := O.choose_mem (rs.filter (!·.isOk)) (by simpa using hne)
    rw [h] at hmem
    simp only [List.mem_filter, Bool.not_eq_eq_eq_not, Bool.not_true] at hmem
    exact hmem

theorem map_failure (O : Oracle) (label : String) (bodyAs : Option String) (resultPath : Option Path)
    (f : Nat → Value → Run) (items : List Value) (o : Outcome)
    (hg : gather O (((runItems f 0 items).map (fun r => mapSelect label bodyAs resultPath r.1)).map (·.1)) = .error o) :
    (∃ i x, (f i x).1 = o) ∨ (∃ p, o = .failed (.state .missingMapResult label p)) := by
  obtain ⟨hmem, hnok⟩ := gather_error' O _ o hg
  simp only [List.map_map, List.mem_map, Function.comp] at hmem
  obtain ⟨r, hr, hro⟩ := hmem
  obtain ⟨i, x, rfl⟩ := runItems_mem f 0 items r hr
  cases hfx : (f i x).1 with
  | ok s' =>
    rw [hfx] at hro
    simp only [mapSelect] at hro
    split at hro
    · split at hro
      · subst hro; simp [Outcome.isOk] at hnok
      · right; exact ⟨_, hro.symm⟩
    · split at hro <;> (subst hro; simp [Outcome.isOk] at hnok)
  | escalated e => left; rw [hfx] at hro; exact ⟨i, x, by rw [hfx]; simpa [mapSelect] using hro⟩
  | failed e => left; rw [hfx] at hro; exact ⟨i, x, by rw [hfx]; simpa [mapSelect] using hro⟩

theorem loopRun_failure (body : Nat → State → Run) (u : Nat → State → Except Err Bool) :
    ∀ (n i : Nat) (s : State) (e : Err) (ev : List Event) (x : Option Nat),
      loopRun body u n i s = (.failed e, ev, x) →
        (∃ j st, (body j st).1 = .failed e) ∨ (∃ j st, u j st = .error e)
  | 0, _, _, _, _, _, h => by simp [loopRun] at h
  | k + 1, i, s, e, ev, x, h => by
    simp only [loopRun] at h
    rcases h1 : body i s with ⟨o1, ev1⟩
    rw [h1] at h
    cases o1 with
    | ok s1 =>
      simp only at h
      rcases hu : u i s1 with e' | c
      · rw [hu] at h; simp only [Prod.mk.injEq, Outcome.failed.injEq] at h
        right; exact ⟨i, s1, by rw [hu, h.1]⟩
      · rw [hu] at h
        cases c with
        | true => simp at h
        | false =>
          simp only at h
          rcases hr : loopRun body u k (i + 1) s1 with ⟨o2, ev2, x2⟩
          rw [hr] at h
          simp only [Prod.mk.injEq] at h
          obtain ⟨rfl, -, -⟩ := h
          exact loopRun_failure body u k (i + 1) s1 e ev2 x2 hr
    | escalated _ => simp at h
    | failed e' =>
      simp only [Prod.mk.injEq, Outcome.failed.injEq] at h
      left; exact ⟨i, s, by rw [h1, h.1]⟩

theorem mergeParallel_not_required (label : String) (s : State) (outs : List State) (l : String) (a : Addr)
    (p : Path) (hp : Bool) : mergeParallel label s outs ≠ .failed (.required l a p hp) := by
  unfold mergeParallel; dsimp only
  split
  · simp
  · split <;> simp

theorem promptState_error (label : String) (s : State) (st : Option Tmpl) (e : Err)
    (h : promptState label s st = .error e) : ∀ l a p hp, e ≠ .required l a p hp := by
  intro l a p hp he; subst he
  cases st with
  | none => simp [promptState] at h
  | some t =>
    simp only [promptState] at h
    split at h <;> simp at h

theorem evalPred_error (O : Oracle) (ctx : Ctx) (s : State) (pr : Pred) (e : Err)
    (h : evalPred O ctx s pr = .error e) : ∀ l a p hp, e ≠ .required l a p hp := by
  intro l a p hp he; subst he
  cases pr with
  | ask gte st =>
    simp only [evalPred] at h
    rcases hps : promptState ctx.label s st with e' | asked
    · rw [hps] at h; simp only [Except.error.injEq] at h; subst h
      exact promptState_error _ _ _ _ hps l a p hp rfl
    · rw [hps] at h; simp only at h; split at h <;> simp at h
  | _ => simp [evalPred] at h

mutual
theorem walk_untracked : ∀ (n : Node) (addr : Addr) (env : VEnv), env.avail = none → (walk n addr env).avail = none
  | .chain steps, addr, env, h => by simp only [walk]; exact walkList_untracked steps 0 addr env h
  | .code .., _, _, _ => rfl
  | .gen .., _, env, h => by simp [walk, addAvail, h]
  | .report .., _, env, h => by simp [walk, addAvail, h]
  | .artifact _ type .., _, env, h => by simp only [walk]; split <;> simp [addAvail, h]
  | .map .., _, _, _ => rfl
  | .parallel .., _, _, _ => rfl
  | .loop .., _, _, _ => rfl
  | .escalate .., _, env, h => by simp [walk, h]
  | .judge .., _, env, h => by simp [walk, addAvail, h]
  | .pick .., _, env, h => by simp [walk, addAvail, h]
  | .sift .., _, env, h => by simp [walk, addAvail, h]
  | .route .., _, _, _ => rfl
  | .dispatch .., _, _, _ => rfl
  | .call .., _, env, h => by simp [walk, addAvail, h]
  | .workflow .., _, env, h => by simp [walk, addAvail, h]
theorem walkList_untracked : ∀ (ns : List Node) (i : Nat) (addr : Addr) (env : VEnv), env.avail = none →
    (walkList ns i addr env).avail = none
  | [], _, _, env, h => by simp [walkList, h]
  | n :: ns, i, addr, env, h => by
    simp only [walkList]
    exact walkList_untracked ns (i + 1) addr _ (walk_untracked n _ env h)
end

theorem interpFields_keys (s : State) : ∀ (input : List (String × Tmpl)) (ci : List (String × Value)),
    interpFields s input = .ok ci → ci.map (·.1) = input.map (·.1)
  | [], ci, h => by simp only [interpFields, Except.ok.injEq] at h; subst h; rfl
  | (k, t) :: rest, ci, h => by
    simp only [interpFields] at h
    split at h
    · rename_i v vs _ h2
      simp only [Except.ok.injEq] at h; subst h
      simp [interpFields_keys s rest vs h2]
    · simp at h
    · simp at h


set_option hygiene false in
/-- Close `h : (match …).1 = .failed (.required …)` where no branch raises `required`. -/
macro "no_required" : tactic => `(tactic| ((repeat' split at h) <;> simp at h))

set_option hygiene false in
/-- Reduce `hr : (match …) = (.ok s0, ev0)` to its completing branch. -/
macro "peel_ok" : tactic => `(tactic| (
  repeat' (split at hr)
  all_goals (try (simp at hr; done))
  all_goals (simp only [Prod.mk.injEq, Outcome.ok.injEq] at hr; obtain ⟨rfl, -⟩ := hr)))

/-- The T1 invariant of one node run from a state covering the validator's tracked keys:
(A) any `required` failure with an absent head is below the node and at an address the
validator did not check; (B) a completed run covers the keys tracked after the node. -/
def ReqSound (O : Oracle) (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (env : VEnv) (s : State) : Prop :=
  (∀ l a p, (eval O n path addr lp s).1 = .failed (.required l a p false) →
    addr <+: a ∧ a ∉ (walk n addr env).checked) ∧
  (∀ s' ev, eval O n path addr lp s = (.ok s', ev) → Covers (walk n addr env).avail s')

theorem step_A (O : Oracle) (ctx : Ctx) (label : String) (addr : Addr) (s : State) (requires : List Path)
    (avail : Option (List String)) (hc : Covers avail s) (hreq : requiresErrors avail requires = [])
    (rest : Run) (l : String) (a : Addr) (p : Path)
    (hrest : ∀ l a p hp, rest.1 ≠ .failed (.required l a p hp))
    (h : (stepWrap O true ctx (match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => rest)).1 = .failed (.required l a p false)) :
    addr <+: a ∧ a ∉ checkedAt avail addr := by
  rcases stepWrap_required _ _ _ _ _ h with h | h
  · rcases h1 : checkRequires label addr s requires with e | _
    · rw [h1] at h; simp only [Outcome.failed.injEq] at h
      obtain ⟨rfl, hna⟩ := own_requires label addr s requires avail hc hreq e h1 l a p h
      exact ⟨List.prefix_refl _, hna⟩
    · rw [h1] at h; exact absurd h (hrest l a p false)
  · simp at h

theorem finishCore_errors (h : Header) (root : Node) (r : VOut) (he : (finishCore h root r).errors = []) :
    r.errors = [] := by
  simp only [finishCore, List.append_eq_nil_iff] at he; exact he.1.1.2

theorem covers_child (s : State) (input : List (String × Tmpl)) (ci : List (String × Value))
    (h : interpFields s input = .ok ci) : Covers (some (input.map (·.1))) ci := by
  intro L hL k hk
  simp only [Option.some.injEq] at hL; subst hL
  apply State.has_of_mem_keys
  simp only [State.keys]; rw [interpFields_keys s input ci h]; exact hk

set_option hygiene false in
/-- Discharge `rest` failures that are never `required` (promptState errors, adapters, engine). -/
macro "rest_not_required" : tactic => `(tactic| (
  intro l a p hp h
  repeat' split at h
  all_goals (try (simp at h; done))
  all_goals exact promptState_error _ _ _ _ (by assumption) l a p hp (by simp_all)))

set_option hygiene false in
/-- `Covers` after a step that sets its keys: old keys persist, new keys are present. -/
macro "covers_step" : tactic => `(tactic| (
  simp only [walk]
  refine covers_add _ hc (fun k hk => hmono k (by simp [State.has_set_iff, withHost_has_iff, hk])) ?_
  intro k hk; apply hmono
  revert k hk
  simp_all [State.has_set_iff, withHost_has_iff]))

theorem setOpt_has_of_ok (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) (out as : String) (s : State)
    (o : Option Value) (h : O.schemaOk out o = true) (k : String) :
    (s.has k = true → (s.setOpt as o).has k = true) ∧ (s.setOpt as o).has as = true := by
  cases o with
  | none => simp [hO] at h
  | some v =>
    simp only [State.setOpt]
    exact ⟨fun hk => State.has_set _ _ _ _ hk, State.has_set_self _ _ _⟩

mutual
theorem req_sound (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) :
    ∀ (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (env : VEnv) (s : State),
      (walk n addr env).errors = [] → Covers env.avail s → ReqSound O n path addr lp env s
  | .chain steps, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    have ih := req_chain O hO steps 0 path addr lp env s herr.2 hc
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      obtain ⟨⟨j, _, hj⟩, hna⟩ := ih.1 l a p h
      exact ⟨prefix_trans_seg hj, by simpa [walk] using hna⟩
    · simp only [eval] at h; simpa [walk] using ih.2 s' ev h
  | .code label as, path, addr, lp, env, s, herr, hc => by
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    rcases stepWrap_required _ _ _ _ _ h with h | h
    · no_required
    · simp at h
  | .gen kind label out as requires st verify, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
      simpa [walk] using this
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      all_goals covers_step
  | .report label requires st, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval, evalReport] at h
      have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
      simpa [walk] using this
    · simp only [eval, evalReport] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      covers_step
  | .artifact label type fpath requires st, path, addr, lp, env, s, herr, hc => by
    by_cases hp : artifactIsProse type
    · simp only [walk, hp, if_true, List.append_eq_nil_iff] at herr
      refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
      · simp only [eval, hp, if_true, evalReport] at h
        have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
        simpa [walk, hp] using this
      · simp only [eval, hp, if_true, evalReport] at h
        obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
        peel_ok
        simp only [walk, hp, if_true]
        refine covers_add _ hc (fun k hk => hmono k ?_) (fun k hk => hmono k ?_)
        · exact withHost_has _ _ _ (by simp [State.has_set_iff, hk])
        · simp at hk; subst hk; exact withHost_has _ _ _ (by simp [State.has_set_iff])
    · simp only [walk, hp, Bool.false_eq_true, if_false, List.append_eq_nil_iff] at herr
      refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
      · simp only [eval, hp, Bool.false_eq_true, if_false] at h
        have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by
          intro l a p hp h; simp at h) h
        simpa [walk, hp] using this
      · simp only [eval, hp, Bool.false_eq_true, if_false] at h
        obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
        peel_ok
        simp only [walk, hp, Bool.false_eq_true, if_false]
        refine covers_add _ hc (fun k hk => hmono k ?_) (fun k hk => hmono k ?_)
        · simp [State.has_set_iff, hk]
        · simp at hk; subst hk; simp [State.has_set_iff]
  | .map label itemsPath body as resultPath, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    split at h
    · rename_i items _
      split at h
      · rename_i o hg
        simp only at h; subst h
        rcases map_failure O label body.asField resultPath _ items _ hg with ⟨i, x, hix⟩ | ⟨q, hq⟩
        · have ih := (req_sound O hO body (path ++ ["items", seg i, "body"]) (addr ++ [.body]) lp
            { env with avail := none } ((s.set "item" x).set "item_index" (.num i)) herr.2 (covers_none _)).1 l a p hix
          exact ⟨prefix_trans_seg ih.1, by simpa [walk] using ih.2⟩
        · simp at hq
      · simp at h
    · simp at h
  | .parallel label branches, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    split at h
    · rename_i o hg; simp only at h; subst h
      obtain ⟨hmem, _⟩ := gather_error' O _ _ hg
      obtain ⟨r, hr, hro⟩ := List.mem_map.mp hmem
      obtain ⟨⟨j, _, hj⟩, hna⟩ := req_branches O hO branches 0 path addr lp { env with avail := none } s herr.2 rfl r hr l a p hro
      exact ⟨prefix_trans_seg hj, by simpa [walk] using hna⟩
    · simp only at h; exact absurd h (mergeParallel_not_required _ _ _ _ _ _ _)
  | .loop label body u maxIters, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    rcases hr : loopRun (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u) maxIters 0 s with ⟨o, ev, x⟩
    rw [hr] at h
    cases o with
    | ok _ => cases x <;> simp at h
    | escalated _ => simp at h
    | failed e =>
      simp only [Outcome.failed.injEq] at h; subst h
      rcases loopRun_failure _ _ _ _ _ _ _ _ hr with ⟨j, st, hj⟩ | ⟨j, st, hj⟩
      · have ih := (req_sound O hO body _ (addr ++ [.body]) lp { env with avail := none } st herr.2 (covers_none _)).1 l a p hj
        exact ⟨prefix_trans_seg ih.1, by simpa [walk] using ih.2⟩
      · exact absurd rfl (evalPred_error _ _ _ _ _ hj l a p false)
  | .escalate label w kind stage summary, path, addr, lp, env, s, herr, hc => by
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      split at h
      · rename_i e he; simp only [Outcome.failed.injEq] at h; subst h
        exact absurd rfl (evalPred_error _ _ _ _ _ he l a p false)
      · split at h <;> simp at h
    · simp only [eval] at h
      split at h
      · simp at h
      · split at h
        · simp at h
        · simp only [Prod.mk.injEq, Outcome.ok.injEq] at h; obtain ⟨rfl, -⟩ := h
          simpa [walk] using hc
  | .judge label st out as requires, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
      simpa [walk] using this
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      covers_step
  | .pick label itemsPath describe allowNone st as requires, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
      simpa [walk] using this
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      all_goals covers_step
  | .sift label itemsPath st out questions keep as requires, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      have := step_A O _ label addr s requires env.avail hc herr.2 _ l a p (by rest_not_required) h
      simpa [walk] using this
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      all_goals covers_step
  | .dispatch label vp branches otherwise as requires, path, addr, lp, env, s, herr, hc => by
    have hnodup : (branchNames branches).Nodup := by
      rcases Decidable.em (branchNames branches).Nodup with hn | hn
      · exact hn
      · simp [walk, hn] at herr
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    rcases h1 : checkRequires label addr s requires with e | _
    · rw [h1] at h; simp only [Outcome.failed.injEq] at h
      obtain ⟨rfl, hna⟩ := own_requires label addr s requires env.avail hc herr.1.2 e h1 l a p h
      refine ⟨List.prefix_refl _, ?_⟩
      simp only [walk, List.mem_append, not_or]
      exact ⟨hna, fun hm => by obtain ⟨_, _, hp⟩ := walkNamed_checked _ _ _ _ hm; exact not_prefix_self_seg hp⟩
    · rw [h1] at h; dsimp only at h
      rcases h2 : dispatchChoice s vp (branchNames branches) otherwise with reason | ⟨value, taken, fallback⟩
      · rw [h2] at h; simp at h
      rw [h2] at h; dsimp only at h
      split at h
      · rename_i o ev' heq
        simp only at h
        obtain ⟨⟨nm, _, hp⟩, hna⟩ := req_named O hO branches _ path addr lp { env with avail := none } _ _
          herr.2 rfl hnodup heq l a p h
        refine ⟨prefix_trans_seg hp, ?_⟩
        simp only [walk, List.mem_append, not_or]
        refine ⟨fun hm => ?_, hna⟩
        rw [checkedAt_prefix _ _ _ hm] at hp; exact not_prefix_self_seg hp
      · simp at h
  | .route label st branches unsure as requires, path, addr, lp, env, s, herr, hc => by
    have hnodup : (branchNames branches).Nodup := by
      rcases Decidable.em (branchNames branches).Nodup with hn | hn
      · exact hn
      · simp [walk, hn] at herr
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => by simp only [walk]; exact covers_none _⟩
    simp only [eval] at h
    rcases h1 : checkRequires label addr s requires with e | _
    · rw [h1] at h; simp only [Outcome.failed.injEq] at h
      obtain ⟨rfl, hna⟩ := own_requires label addr s requires env.avail hc herr.1.2 e h1 l a p h
      refine ⟨List.prefix_refl _, ?_⟩
      simp only [walk, List.mem_append, not_or]
      exact ⟨hna, fun hm => by obtain ⟨_, _, hp⟩ := walkNamed_checked _ _ _ _ hm; exact not_prefix_self_seg hp⟩
    · rw [h1] at h; dsimp only at h
      rcases h2 : promptState label s (some st) with e | asked
      · rw [h2] at h; simp only [Outcome.failed.injEq] at h
        exact absurd h (promptState_error _ _ _ _ h2 l a p false)
      rw [h2] at h; dsimp only at h
      rcases h3 : O.route ⟨path, lp ++ label⟩ asked with m | ⟨choice, conf, sidecar⟩
      · rw [h3] at h; simp at h
      rw [h3] at h; dsimp only at h
      split at h
      · simp at h
      · split at h
        · rename_i o ev' heq
          simp only at h
          obtain ⟨⟨nm, _, hp⟩, hna⟩ := req_named O hO branches _ path addr lp { env with avail := none } _ _
            herr.2 rfl hnodup heq l a p h
          refine ⟨prefix_trans_seg hp, ?_⟩
          simp only [walk, List.mem_append, not_or]
          refine ⟨fun hm => ?_, hna⟩
          rw [checkedAt_prefix _ _ _ hm] at hp; exact not_prefix_self_seg hp
        · simp at h
  | .call label via input out as produces requires, path, addr, lp, env, s, herr, hc => by
    simp only [walk, List.append_eq_nil_iff] at herr
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      have := step_A O _ label addr s requires env.avail hc herr.1.2 _ l a p (by
        intro l a p hp h
        repeat' split at h
        all_goals simp at h) h
      simpa [walk] using this
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      peel_ok
      covers_step
  | .workflow label child root input out as, path, addr, lp, env, s, herr, hc => by
    have hcerr : (walk root (addr ++ [.child]) ⟨some (input.map (·.1)), [], child.schemas⟩).errors = [] := by
      simp only [walk, List.append_eq_nil_iff] at herr
      exact finishCore_errors _ _ _ herr.1.2
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [eval] at h
      rcases stepWrap_required _ _ _ _ _ h with h | h
      · rcases h1 : interpFields s input with q | ci
        · rw [h1] at h; simp at h
        rw [h1] at h; dsimp only at h
        rcases hcev : eval O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") ci with ⟨o, evc⟩
        rw [hcev] at h
        have ih := (req_sound O hO root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") _ ci
          hcerr (covers_child s input ci h1)).1
        cases o with
        | failed e =>
          dsimp only at h
          repeat' split at h
          all_goals (try (simp at h; done))
          all_goals
            simp only [Outcome.failed.injEq] at h; subst h
            have := ih l a p (by rw [hcev])
            exact ⟨prefix_trans_seg this.1, by simpa [walk, finishCore] using this.2⟩
        | escalated _ => dsimp only at h; no_required
        | ok _ => dsimp only at h; no_required
      · simp at h
    · simp only [eval] at h
      obtain ⟨s0, ev0, hr, -, hmono⟩ := stepWrap_ok _ _ _ _ _ _ h
      rcases h1 : interpFields s input with q | ci
      · rw [h1] at hr; simp at hr
      rw [h1] at hr; dsimp only at hr
      rcases hcev : eval O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") ci with ⟨o, evc⟩
      rw [hcev] at hr
      cases o <;> dsimp only at hr <;> peel_ok
      all_goals
        simp only [walk]
        refine covers_add _ hc (fun k hk => hmono k ?_) ?_
        · exact (setOpt_has_of_ok O hO out as s _ (by simp_all) k).1 hk
        · intro k hk; apply hmono; simp only [List.mem_singleton] at hk; subst hk
          exact (setOpt_has_of_ok O hO out k s _ (by simp_all) k).2

theorem req_chain (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) :
    ∀ (ns : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (env : VEnv) (s : State),
      (walkList ns i addr env).errors = [] → Covers env.avail s →
      (∀ l a p, (evalChain O ns i path addr lp s).1 = .failed (.required l a p false) →
        (∃ j, i ≤ j ∧ (addr ++ [.step j]) <+: a) ∧ a ∉ (walkList ns i addr env).checked) ∧
      (∀ s' ev, evalChain O ns i path addr lp s = (.ok s', ev) → Covers (walkList ns i addr env).avail s')
  | [], i, path, addr, lp, env, s, _, hc => by
    refine ⟨fun l a p h => by simp [evalChain] at h, fun s' ev h => ?_⟩
    simp only [evalChain, Prod.mk.injEq, Outcome.ok.injEq] at h; obtain ⟨rfl, -⟩ := h
    simpa [walkList] using hc
  | n :: ns, i, path, addr, lp, env, s, herr, hc => by
    simp only [walkList, List.append_eq_nil_iff] at herr ⊢
    have ihn := req_sound O hO n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp env s herr.1 hc
    refine ⟨fun l a p h => ?_, fun s' ev h => ?_⟩
    · simp only [evalChain] at h
      rcases hr : eval O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s with ⟨o, ev1⟩
      rw [hr] at h
      cases o with
      | ok s1 =>
        simp only at h
        have ihr := req_chain O hO ns (i + 1) path addr lp
          ⟨(walk n (addr ++ [.step i]) env).avail, (walk n (addr ++ [.step i]) env).produced, env.schemas⟩
          s1 herr.2 (ihn.2 s1 ev1 hr)
        obtain ⟨⟨j, hj, hp⟩, hna⟩ := ihr.1 l a p h
        refine ⟨⟨j, by omega, hp⟩, ?_⟩
        simp only [List.mem_append, not_or]
        refine ⟨fun hm => ?_, hna⟩
        have := prefix_clash (walk_checked n _ env a hm) hp
        simp at this; omega
      | escalated _ => simp at h
      | failed e =>
        simp only at h
        have := ihn.1 l a p (by rw [hr]; exact h)
        refine ⟨⟨i, Nat.le_refl _, this.1⟩, ?_⟩
        simp only [List.mem_append, not_or]
        refine ⟨this.2, fun hm => ?_⟩
        obtain ⟨j, hj, hp⟩ := walkList_checked ns (i + 1) addr _ a hm
        have := prefix_clash this.1 hp
        simp at this; omega
    · simp only [evalChain] at h
      rcases hr : eval O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s with ⟨o, ev1⟩
      rw [hr] at h
      cases o with
      | ok s1 =>
        simp only at h
        have ihr := req_chain O hO ns (i + 1) path addr lp
          ⟨(walk n (addr ++ [.step i]) env).avail, (walk n (addr ++ [.step i]) env).produced, env.schemas⟩
          s1 herr.2 (ihn.2 s1 ev1 hr)
        rcases hr2 : evalChain O ns (i + 1) path addr lp s1 with ⟨o2, ev2⟩
        rw [hr2] at h
        simp only [Prod.mk.injEq] at h; obtain ⟨rfl, -⟩ := h
        exact ihr.2 s' ev2 hr2
      | escalated _ | failed _ => simp at h

theorem req_branches (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) :
    ∀ (bs : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (env : VEnv) (s : State),
      (walkBranches bs i addr env).errors = [] → env.avail = none →
      ∀ r ∈ evalBranches O bs i path addr lp s, ∀ l a p, r.1 = .failed (.required l a p false) →
        (∃ j, i ≤ j ∧ (addr ++ [.branch j]) <+: a) ∧ a ∉ (walkBranches bs i addr env).checked
  | [], _, _, _, _, _, _, _, _, r, hr, _, _, _, _ => by simp [evalBranches] at hr
  | b :: bs, i, path, addr, lp, env, s, herr, hnone, r, hr, l, a, p, hf => by
    simp only [walkBranches, List.append_eq_nil_iff] at herr ⊢
    simp only [evalBranches, List.mem_cons] at hr
    rcases hr with rfl | hr
    · have ih := (req_sound O hO b _ (addr ++ [.branch i]) lp env s herr.1 (by rw [hnone]; exact covers_none _)).1 l a p hf
      refine ⟨⟨i, Nat.le_refl _, ih.1⟩, ?_⟩
      simp only [List.mem_append, not_or]
      refine ⟨ih.2, fun hm => ?_⟩
      obtain ⟨j, hj, hp⟩ := walkBranches_checked bs (i + 1) addr _ a hm
      have := prefix_clash ih.1 hp; simp at this; omega
    · obtain ⟨⟨j, hj, hp⟩, hna⟩ := req_branches O hO bs (i + 1) path addr lp _ s herr.2
        (walk_untracked b _ env hnone) r hr l a p hf
      refine ⟨⟨j, by omega, hp⟩, ?_⟩
      simp only [List.mem_append, not_or]
      refine ⟨fun hm => ?_, hna⟩
      have := prefix_clash (walk_checked b _ env a hm) hp; simp at this; omega

theorem req_named (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) :
    ∀ (bs : List (String × Node)) (taken : String) (path : ExecPath) (addr : Addr) (lp : String) (env : VEnv)
      (st : State) (r : Run),
      (walkNamed bs addr env).errors = [] → env.avail = none → (branchNames bs).Nodup →
      evalNamed O bs taken path addr lp st = some r → ∀ l a p, r.1 = .failed (.required l a p false) →
        (∃ name ∈ branchNames bs, (addr ++ [.named name]) <+: a) ∧ a ∉ (walkNamed bs addr env).checked
  | [], _, _, _, _, _, _, _, _, _, _, h, _, _, _, _ => by simp [evalNamed] at h
  | (name, b) :: rest, taken, path, addr, lp, env, st, r, herr, hnone, hnd, h, l, a, p, hf => by
    simp only [walkNamed, List.append_eq_nil_iff] at herr ⊢
    have hnd' : name ∉ branchNames rest ∧ (branchNames rest).Nodup := by
      simpa [branchNames] using hnd
    simp only [evalNamed] at h
    split at h
    · simp only [Option.some.injEq] at h; subst h
      have ih := (req_sound O hO b _ (addr ++ [.named name]) lp env st herr.1 (by rw [hnone]; exact covers_none _)).1 l a p hf
      refine ⟨⟨name, by simp [branchNames], ih.1⟩, ?_⟩
      simp only [List.mem_append, not_or]
      refine ⟨ih.2, fun hm => ?_⟩
      obtain ⟨nm, hnm, hp⟩ := walkNamed_checked rest addr _ a hm
      have := prefix_clash ih.1 hp; simp at this; subst this; exact hnd'.1 hnm
    · obtain ⟨⟨nm, hnm, hp⟩, hna⟩ := req_named O hO rest taken path addr lp _ st r herr.2
        (walk_untracked b _ env hnone) hnd'.2 h l a p hf
      refine ⟨⟨nm, by simp [branchNames] at hnm ⊢; exact Or.inr hnm, hp⟩, ?_⟩
      simp only [List.mem_append, not_or]
      refine ⟨fun hm => ?_, hna⟩
      have := prefix_clash (walk_checked b _ env a hm) hp; simp at this; subst this; exact hnd'.1 hnm
end


/-- **T1 (what holds).** For every oracle whose schema checks reject `undefined`, and every
workflow and input that `validate` accepts with the input's keys: no node whose `requires`
the validator checked (a node reached while its reachability was knowable) ever fails
`required_nonempty` because the first key of a required path is absent. -/
theorem T1_requires_sound (O : Oracle) (hO : ∀ id, O.schemaOk id none = false) (wf : Workflow) (input : State)
    (hv : (validate wf (some input.keys)).ok = true) (a : Addr) (ha : a ∈ (validate wf (some input.keys)).checked)
    (l : String) (p : Path) : (runWorkflow O wf input).outcome ≠ .failed (.required l a p false) := by
  intro h
  have herr : (walk (desugar wf.root) [] ⟨some input.keys, [], wf.header.schemas⟩).errors = [] := by
    simp only [validate, validateCore, VOut.ok, List.isEmpty_iff] at hv
    exact finishCore_errors _ _ _ hv
  have hch : a ∈ (walk (desugar wf.root) [] ⟨some input.keys, [], wf.header.schemas⟩).checked := by
    simpa [validate, validateCore, finishCore] using ha
  have hcov : Covers (some input.keys) input := fun L hL k hk => by
    simp only [Option.some.injEq] at hL; subst hL; exact State.has_of_mem_keys _ _ hk
  have key := (req_sound O hO (desugar wf.root) ["root"] [] "" _ input herr hcov).1 l a p
  unfold runWorkflow at h
  repeat' split at h
  all_goals (try (simp at h; done))
  all_goals first
    | (rw [apply_ite RunResult.outcome] at h; split at h <;> simp at h)
    | (rename_i heq
       simp only at h
       exact (key (by rw [heq]; exact h)).2 hch)

end AgentRun
