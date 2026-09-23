import AgentRunSemantics.Lemmas

/-!
# T2: a node changes only what it may write

`mayWrite n k` is the syntactic write set of a node: its `as` key (or label), the engine's
`<as>$answers` / `<as>$verify` sidecars, `report_markdown`, `artifact`, and `$host` for
generative nodes, through every container. An unaliased code node may write any key but
`$host`. The frame theorem: for every oracle without `afterNode`, a completed run of `n`
leaves every key outside `mayWrite n` untouched; with `afterNode`, `$host` is still
untouched outside generative nodes.
-/

namespace AgentRun

mutual
theorem Value.structEq_refl : ∀ v : Value, Value.structEq v v = true
  | .null => rfl
  | .bool b => by simp [Value.structEq]
  | .num n => by simp [Value.structEq]
  | .str s => by simp [Value.structEq]
  | .arr xs => by simp only [Value.structEq]; exact Value.structEqList_refl xs
  | .obj kvs => by simp only [Value.structEq]; exact Value.structEqFields_refl kvs
theorem Value.structEqList_refl : ∀ xs : List Value, Value.structEqList xs xs = true
  | [] => rfl
  | x :: xs => by simp [Value.structEqList, Value.structEq_refl x, Value.structEqList_refl xs]
theorem Value.structEqFields_refl : ∀ kvs : List (String × Value), Value.structEqFields kvs kvs = true
  | [] => rfl
  | (k, v) :: rest => by simp [Value.structEqFields, Value.structEq_refl v, Value.structEqFields_refl rest]
end

theorem Value.eqv_refl (v : Value) : Value.eqv v v = true := by simp [Value.eqv, Value.structEq_refl]

theorem State.mem_entries (s : State) (k : String) (v : Value) (h : (k, v) ∈ s.entries) : s.get k = some v := by
  simp only [State.entries, List.mem_filterMap, Option.map_eq_some_iff, Prod.mk.injEq] at h
  obtain ⟨k', _, v', hv, rfl, rfl⟩ := h
  exact hv

theorem State.get_setOpt_ne (s : State) {k k' : String} (o : Option Value) (h : k ≠ k') :
    (s.setOpt k o).get k' = s.get k' := by
  cases o with
  | some v => exact State.get_set_ne s v h
  | none => exact State.get_erase_ne s h

theorem withHost_get_ne (s : State) (h : List (String × Value)) {k : String} (hk : k ≠ hostKey) :
    (withHost s h).get k = s.get k := by
  unfold withHost; split
  · rfl
  · exact State.get_set_ne s _ (Ne.symm hk)

theorem lookup_isSome_of_mem (k : String) : ∀ (l : List (String × Value)) (p : String × Value),
    p ∈ l → p.1 = k → (lookup k l).isSome = true
  | [], _, hp, _ => by simp at hp
  | (k', v) :: rest, p, hp, hk => by
    simp only [lookup]
    split
    · rfl
    · rcases List.mem_cons.mp hp with rfl | hp'
      · rename_i hne; exact absurd hk hne
      · exact lookup_isSome_of_mem k rest p hp' hk

/-- A completed step: the body completed, and the host's `afterNode` patch touched no
`$host` and only added keys. -/
theorem stepWrap_ok (O : Oracle) (b : Bool) (ctx : Ctx) (r : Run) (s' : State) (ev : List Event)
    (h : stepWrap O b ctx r = (.ok s', ev)) :
    ∃ s0 ev0, r = (.ok s0, ev0) ∧
      (∀ k, (O.afterNode = none ∨ k = hostKey) → s'.get k = s0.get k) ∧
      (∀ k, s0.has k → s'.has k) := by
  obtain ⟨o, ev0⟩ := r
  cases b with
  | false =>
    simp only [stepWrap, Bool.false_eq_true, if_false] at h
    rw [h]
    exact ⟨s', ev, rfl, fun _ _ => rfl, fun _ hk => hk⟩
  | true =>
    simp only [stepWrap, if_true] at h
    cases o with
    | ok s0 =>
      refine ⟨s0, ev0, rfl, ?_⟩
      cases hA : O.afterNode with
      | none =>
        simp only [hA, Prod.mk.injEq, Outcome.ok.injEq] at h
        obtain ⟨rfl, _⟩ := h
        exact ⟨fun _ _ => rfl, fun _ hk => hk⟩
      | some f =>
        simp only [hA] at h
        split at h
        · simp at h
        · rename_i hno
          simp only [Prod.mk.injEq, Outcome.ok.injEq] at h
          obtain ⟨rfl, _⟩ := h
          refine ⟨fun k hk => ?_, fun k hk => State.has_setAll _ _ _ hk⟩
          rcases hk with hk | rfl
          · simp at hk
          · apply State.get_setAll_not_mem
            intro p hp heq
            exact hno (lookup_isSome_of_mem hostKey (f ctx s0) p hp heq)
    | escalated _ => simp at h
    | failed _ => simp at h

/-! ## The parallel merge only writes what some branch changed -/

theorem mergePatch_get : ∀ (p : List (String × Value)) (w w' : List String) (m m' : State) (k : String),
    mergePatch p w m = .ok (w', m') → (∀ kv ∈ p, kv.1 ≠ k) → m'.get k = m.get k
  | [], _, _, m, m', _, h, _ => by
    simp only [mergePatch, Except.ok.injEq, Prod.mk.injEq] at h; rw [h.2]
  | (k', v) :: rest, w, w', m, m', k, h, hk => by
    simp only [mergePatch] at h
    split at h
    · simp at h
    · rw [mergePatch_get rest (k' :: w) w' (m.set k' v) m' k h (fun kv hkv => hk kv (List.mem_cons_of_mem _ hkv))]
      exact State.get_set_ne m v (hk _ (List.mem_cons_self ..))

theorem mergePatches_get : ∀ (ps : List (List (String × Value))) (w : List String) (m m' : State) (k : String),
    mergePatches ps w m = .ok m' → (∀ p ∈ ps, ∀ kv ∈ p, kv.1 ≠ k) → m'.get k = m.get k
  | [], _, m, m', _, h, _ => by simp only [mergePatches, Except.ok.injEq] at h; rw [h]
  | p :: ps, w, m, m', k, h, hk => by
    simp only [mergePatches] at h
    split at h
    · rename_i w1 m1 h1
      rw [mergePatches_get ps w1 m1 m' k h (fun q hq => hk q (List.mem_cons_of_mem _ hq))]
      exact mergePatch_get p w w1 m m1 k h1 (hk p (List.mem_cons_self ..))
    · simp at h

theorem hostMergeAll_same (base : List (String × Value)) (acc : HostAcc) :
    ∀ l : List (String × Value), (∀ kv ∈ l, lookup kv.1 base = some kv.2) → hostMergeAll base acc l = .ok acc
  | [], _ => rfl
  | (k, v) :: rest, h => by
    simp only [hostMergeAll]
    have hk := h (k, v) (List.mem_cons_self ..)
    have hstep : hostStep base acc (k, v) = .ok acc := by
      simp only at hk; simp [hostStep, hk, Value.eqv_refl]
    rw [hstep]
    exact hostMergeAll_same base acc rest (fun kv hkv => h kv (List.mem_cons_of_mem _ hkv))

theorem hostMerge_same (base : List (String × Value)) (acc : HostAcc) :
    ∀ hs : List (List (String × Value)), (∀ h ∈ hs, h = base) → hostMerge base acc hs = .ok acc
  | [], _ => rfl
  | h :: hs, hh => by
    simp only [hostMerge]
    rw [hh h (List.mem_cons_self ..), hostMergeAll_same base acc _ (fun kv hkv => State.mem_entries base kv.1 kv.2 hkv)]
    exact hostMerge_same base acc hs (fun h' hh' => hh h' (List.mem_cons_of_mem _ hh'))

theorem patchOf_not_mem (s o : State) (k : String) (hk : o.get k = s.get k) : ∀ kv ∈ patchOf s o, kv.1 ≠ k := by
  intro kv hkv heq
  obtain ⟨k', v⟩ := kv
  simp only at heq; subst heq
  simp only [patchOf, List.mem_filter] at hkv
  obtain ⟨hmem, hf⟩ := hkv
  have hget := State.mem_entries o k' v hmem
  rw [hget] at hk
  rw [← hk] at hf
  simp [Value.eqv_refl] at hf

theorem patchOf_no_host (s o : State) : ∀ kv ∈ patchOf s o, kv.1 ≠ hostKey := by
  intro kv hkv heq
  simp only [patchOf, List.mem_filter] at hkv
  obtain ⟨_, hf⟩ := hkv
  simp [heq] at hf

theorem mergeParallel_frame (l : String) (s : State) (outs : List State) (m : State) (k : String)
    (h : mergeParallel l s outs = .ok m) (hk : ∀ o ∈ outs, o.get k = s.get k) : m.get k = s.get k := by
  unfold mergeParallel at h
  dsimp only at h
  split at h
  · simp at h
  · rename_i acc hacc
    split at h
    · rename_i m' hm
      simp only [Outcome.ok.injEq] at h; subst h
      by_cases hkh : k = hostKey
      · subst hkh
        have hsame : hostMerge (hostOf s) ⟨hostOf s, [], false⟩ (outs.map hostOf) = .ok ⟨hostOf s, [], false⟩ :=
          hostMerge_same _ _ _ (by
            intro h' hh'
            obtain ⟨o, ho, rfl⟩ := List.mem_map.mp hh'
            simp [hostOf, hk o ho])
        rw [hsame] at hacc
        simp only [Except.ok.injEq] at hacc; subst hacc
        simp only at hm
        rw [mergePatches_get _ _ _ _ _ hm (by
          intro p hp kv hkv
          obtain ⟨o, _, rfl⟩ := List.mem_map.mp hp
          exact patchOf_no_host s o kv hkv)]
        simp
      · rw [mergePatches_get _ _ _ _ _ hm (by
          intro p hp kv hkv
          obtain ⟨o, ho, rfl⟩ := List.mem_map.mp hp
          exact patchOf_not_mem s o k (hk o ho) kv hkv)]
        split
        · exact State.get_set_ne s _ (Ne.symm hkh)
        · rfl
    · simp at h

theorem gather_error (O : Oracle) (rs : List Outcome) (o : Outcome) (h : gather O rs = .error o) :
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

theorem gather_ok (O : Oracle) (rs : List Outcome) (outs : List State) (h : gather O rs = .ok outs) :
    ∀ o ∈ outs, Outcome.ok o ∈ rs := by
  unfold gather at h
  dsimp only at h
  split at h
  · simp only [Except.ok.injEq] at h; subst h
    intro o ho
    simp only [List.mem_filterMap] at ho
    obtain ⟨r, hr, hro⟩ := ho
    cases r with
    | ok s => simp at hro; subst hro; exact hr
    | escalated _ | failed _ => simp at hro
  · simp at h

theorem loopRun_rel (body : Nat → State → Run) (u : Nat → State → Except Err Bool) (R : State → State → Prop)
    (hrefl : ∀ s, R s s) (htrans : ∀ a b c, R a b → R b c → R a c)
    (hb : ∀ j st st' ev, body j st = (.ok st', ev) → R st st') :
    ∀ (n i : Nat) (s s' : State) (ev : List Event) (x : Option Nat),
      loopRun body u n i s = (.ok s', ev, x) → R s s'
  | 0, _, s, s', _, _, h => by simp only [loopRun, Prod.mk.injEq, Outcome.ok.injEq] at h; rw [← h.1]; exact hrefl s
  | k + 1, i, s, s', ev, x, h => by
    simp only [loopRun] at h
    rcases h1 : body i s with ⟨o1, ev1⟩
    rw [h1] at h
    cases o1 with
    | ok s1 =>
      have r1 := hb i s s1 ev1 h1
      simp only at h
      rcases hu : u i s1 with e | c
      · rw [hu] at h; simp at h
      · rw [hu] at h
        cases c with
        | true => simp only [Prod.mk.injEq, Outcome.ok.injEq] at h; rw [← h.1]; exact r1
        | false =>
          simp only at h
          rcases hr : loopRun body u k (i + 1) s1 with ⟨o2, ev2, x2⟩
          rw [hr] at h
          simp only [Prod.mk.injEq] at h
          obtain ⟨rfl, _, _⟩ := h
          exact htrans _ _ _ r1 (loopRun_rel body u R hrefl htrans hb k (i + 1) s1 s' ev2 x2 hr)
    | escalated _ | failed _ => simp at h


theorem no_host_of_lookup (l : List (String × Value)) (h : ¬ (lookup hostKey l).isSome = true) :
    ∀ p ∈ l, p.1 ≠ hostKey := fun p hp heq => h (lookup_isSome_of_mem hostKey l p hp heq)

mutual
/-- The keys a node may change (T2): `as` or the label for generative and code nodes, the
`$answers` / `$verify` sidecars, `report_markdown`, `artifact`, and `$host` for generative
nodes. An unaliased code node may change any key except `$host`. -/
def mayWrite : Node → String → Bool
  | .chain steps, k => mayWriteList steps k
  | .code _ as, k => match as with
    | some a => a == k
    | none => k != hostKey
  | .gen _ label _ as _ _ verify, k =>
    (as.getD label) == k || (verify.isSome && (as.getD label ++ "$verify") == k) || hostKey == k
  | .report .., k => "report_markdown" == k || hostKey == k
  | .artifact _ type _ _ _, k =>
    if artifactIsProse type then "report_markdown" == k || hostKey == k else "artifact" == k
  | .map _ _ _ as _, k => as == k
  | .parallel _ bs, k => mayWriteList bs k
  | .loop _ body _ _, k => mayWrite body k
  | .escalate .., _ => false
  | .judge _ _ _ as _, k => as == k || (as ++ "$answers") == k
  | .pick _ _ _ _ _ as _, k => as == k || (as ++ "$answers") == k
  | .sift _ _ _ _ _ _ as _, k => as == k
  | .route _ _ bs _ as _, k =>
    (match as with
      | some a => a == k || (a ++ "$answers") == k
      | none => false) || mayWriteNamed bs k
  | .call _ _ _ _ as _ _, k => as == k
  | .workflow _ _ _ _ _ as, k => as == k
def mayWriteList : List Node → String → Bool
  | [], _ => false
  | n :: ns, k => mayWrite n k || mayWriteList ns k
def mayWriteNamed : List (String × Node) → String → Bool
  | [], _ => false
  | (_, n) :: rest, k => mayWrite n k || mayWriteNamed rest k
end

set_option hygiene false in
/-- Walk a hypothesis `hr : (match … ) = (.ok s0, ev0)` down to its completing branch. -/
macro "peel_ok" : tactic => `(tactic| (
  repeat' (split at hr)
  all_goals (try (simp at hr; done))
  all_goals (simp only [Prod.mk.injEq, Outcome.ok.injEq] at hr; obtain ⟨rfl, -⟩ := hr)))

mutual
theorem frame (O : Oracle) (k : String) (hA : O.afterNode = none ∨ k = hostKey) :
    ∀ (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (s s' : State) (ev : List Event),
      mayWrite n k = false → eval O n path addr lp s = (.ok s', ev) → s'.get k = s.get k
  | .chain steps, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h; simp only [mayWrite] at hw
    exact frameChain O k hA steps 0 path addr lp s s' ev hw h
  | .code label as, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    rcases hc : O.code ⟨path, lp ++ label⟩ s with m | out
    · rw [hc] at hr; simp at hr
    · rw [hc] at hr
      dsimp only at hr
      split at hr
      · simp at hr
      · rename_i hno
        simp only [Prod.mk.injEq, Outcome.ok.injEq] at hr; obtain ⟨rfl, -⟩ := hr
        apply State.get_setAll_not_mem
        have hnh := no_host_of_lookup _ hno
        cases as with
        | some a => simp only [mayWrite, beq_eq_false_iff_ne] at hw; simpa [codePatch] using hw
        | none =>
          simp only [mayWrite, bne_eq_false_iff_eq] at hw
          subst hw; exact hnh
  | .gen kind label out as requires st verify, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, Bool.or_eq_false_iff, beq_eq_false_iff_ne, Bool.and_eq_false_iff] at hw
    obtain ⟨⟨h1, h2⟩, h3⟩ := hw
    peel_ok
    all_goals rw [withHost_get_ne _ _ (Ne.symm h3)]
    · rw [State.get_set_ne _ _ (by rcases h2 with h2 | h2 <;> simp_all), State.get_set_ne _ _ h1]
    · rw [State.get_set_ne _ _ h1]
  | .report label requires st, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval, evalReport] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, Bool.or_eq_false_iff, beq_eq_false_iff_ne] at hw
    peel_ok
    rw [withHost_get_ne _ _ (Ne.symm hw.2), State.get_set_ne _ _ hw.1]
  | .artifact label type fpath requires st, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    simp only [mayWrite] at hw
    split at h
    · rename_i hp
      simp only [hp, if_true, Bool.or_eq_false_iff, beq_eq_false_iff_ne] at hw
      simp only [evalReport] at h
      obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
      rw [hget k hA]
      peel_ok
      rw [withHost_get_ne _ _ (Ne.symm hw.2), State.get_set_ne _ _ hw.1]
    · rename_i hp
      simp only [hp, Bool.false_eq_true, if_false, beq_eq_false_iff_ne] at hw
      obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
      rw [hget k hA]
      peel_ok
      rw [State.get_set_ne _ _ hw]
  | .map label itemsPath body as resultPath, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    simp only [mayWrite, beq_eq_false_iff_ne] at hw
    split at h
    · split at h
      · rename_i hg
        simp only [Prod.mk.injEq] at h
        have := (gather_error O _ _ hg).2
        rw [h.1] at this; simp [Outcome.isOk] at this
      · simp only [Prod.mk.injEq, Outcome.ok.injEq] at h; obtain ⟨rfl, -⟩ := h
        rw [State.get_set_ne _ _ hw]
    · simp at h
  | .parallel label branches, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    simp only [mayWrite] at hw
    split at h
    · rename_i o hg
      simp only [Prod.mk.injEq] at h
      have := (gather_error O _ _ hg).2; rw [h.1] at this; simp [Outcome.isOk] at this
    · rename_i outs hg
      simp only [Prod.mk.injEq] at h
      apply mergeParallel_frame label s outs s' k h.1
      intro o ho
      obtain ⟨r, hr, hro⟩ := List.mem_map.mp (gather_ok O _ outs hg o ho)
      exact frameBranches O k hA branches 0 path addr lp s hw r hr o r.2 (by rw [← hro])
  | .loop label body u maxIters, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    simp only [mayWrite] at hw
    have hl := loopRun_rel
      (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u)
      (fun a b => b.get k = a.get k) (fun _ => rfl) (fun a b c h1 h2 => h2.trans h1)
      (fun j st st' ev hb => frame O k hA body _ _ lp st st' ev hw hb) maxIters 0 s
    rcases hr : loopRun (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st u) maxIters 0 s with ⟨o, ev1, x⟩
    rw [hr] at h
    cases o with
    | ok s1 =>
      have := hl s1 ev1 x hr
      cases x <;>
      · simp only [Prod.mk.injEq, Outcome.ok.injEq] at h; obtain ⟨rfl, -⟩ := h; exact this
    | escalated _ | failed _ => simp at h
  | .escalate .., path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    split at h
    · simp at h
    · split at h
      · simp at h
      · simp only [Prod.mk.injEq, Outcome.ok.injEq] at h; obtain ⟨rfl, -⟩ := h; rfl
  | .judge label st out as requires, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, Bool.or_eq_false_iff, beq_eq_false_iff_ne] at hw
    peel_ok
    rw [State.get_set_ne _ _ hw.2, State.get_set_ne _ _ hw.1]
  | .pick label itemsPath describe allowNone st as requires, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, Bool.or_eq_false_iff, beq_eq_false_iff_ne] at hw
    peel_ok
    all_goals rw [State.get_set_ne _ _ hw.2, State.get_set_ne _ _ hw.1]
  | .sift label itemsPath st out questions keep as requires, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, beq_eq_false_iff_ne] at hw
    peel_ok
    all_goals rw [State.get_set_ne _ _ hw]
  | .route label st branches unsure as requires, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    simp only [mayWrite, Bool.or_eq_false_iff] at hw
    rcases h1 : checkRequires label addr s requires with x | _
    · rw [h1] at h; simp at h
    rw [h1] at h; dsimp only at h
    rcases h2 : promptState label s (some st) with x | asked
    · rw [h2] at h; simp at h
    rw [h2] at h; dsimp only at h
    rcases h3 : O.route ⟨path, lp ++ label⟩ asked with x | ⟨choice, conf, sidecar⟩
    · rw [h3] at h; simp at h
    rw [h3] at h; dsimp only at h
    split at h
    · simp at h
    · split at h
      · rename_i o ev' heq
        simp only [Prod.mk.injEq] at h; obtain ⟨rfl, -⟩ := h
        rw [frameNamed O k hA branches _ path addr lp _ hw.2 _ _ heq]
        cases as with
        | none => rfl
        | some a =>
          simp only [Bool.or_eq_false_iff, beq_eq_false_iff_ne] at hw
          simp only
          rw [State.get_set_ne _ _ hw.1.2, State.get_set_ne _ _ hw.1.1]
      · simp at h
  | .call label via input out as produces requires, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, beq_eq_false_iff_ne] at hw
    peel_ok
    rw [State.get_set_ne _ _ hw]
  | .workflow label child root input out as, path, addr, lp, s, s', ev, hw, h => by
    simp only [eval] at h
    obtain ⟨s0, ev0, hr, hget, _⟩ := stepWrap_ok _ _ _ _ _ _ h
    rw [hget k hA]
    simp only [mayWrite, beq_eq_false_iff_ne] at hw
    rcases h1 : interpFields s input with p | childInput
    · rw [h1] at hr; simp at hr
    rw [h1] at hr; dsimp only at hr
    rcases hc : eval O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") childInput with ⟨o, evc⟩
    rw [hc] at hr
    cases o <;> dsimp only at hr <;> peel_ok
    all_goals rw [State.get_setOpt_ne _ _ hw]

theorem frameBranches (O : Oracle) (k : String) (hA : O.afterNode = none ∨ k = hostKey) :
    ∀ (bs : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
      mayWriteList bs k = false → ∀ r ∈ evalBranches O bs i path addr lp s,
        ∀ (o : State) (ev : List Event), r = (.ok o, ev) → o.get k = s.get k
  | [], _, _, _, _, _, _, r, hr, _, _, _ => by simp [evalBranches] at hr
  | b :: bs, i, path, addr, lp, s, hw, r, hr, o, ev, hro => by
    simp only [mayWriteList, Bool.or_eq_false_iff] at hw
    simp only [evalBranches, List.mem_cons] at hr
    rcases hr with rfl | hr
    · exact frame O k hA b _ _ lp s o ev hw.1 hro
    · exact frameBranches O k hA bs (i + 1) path addr lp s hw.2 r hr o ev hro

theorem frameNamed (O : Oracle) (k : String) (hA : O.afterNode = none ∨ k = hostKey) :
    ∀ (bs : List (String × Node)) (taken : String) (path : ExecPath) (addr : Addr) (lp : String) (st : State),
      mayWriteNamed bs k = false → ∀ (s' : State) (ev : List Event),
        evalNamed O bs taken path addr lp st = some (.ok s', ev) → s'.get k = st.get k
  | [], _, _, _, _, _, _, _, _, h => by simp [evalNamed] at h
  | (name, b) :: rest, taken, path, addr, lp, st, hw, s', ev, h => by
    simp only [mayWriteNamed, Bool.or_eq_false_iff] at hw
    simp only [evalNamed] at h
    split at h
    · simp only [Option.some.injEq] at h
      exact frame O k hA b _ _ lp st s' ev hw.1 h
    · exact frameNamed O k hA rest taken path addr lp st hw.2 s' ev h

theorem frameChain (O : Oracle) (k : String) (hA : O.afterNode = none ∨ k = hostKey) :
    ∀ (steps : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s s' : State) (ev : List Event),
      mayWriteList steps k = false → evalChain O steps i path addr lp s = (.ok s', ev) → s'.get k = s.get k
  | [], _, _, _, _, s, s', ev, _, h => by
    simp only [evalChain, Prod.mk.injEq, Outcome.ok.injEq] at h; rw [h.1]
  | n :: ns, i, path, addr, lp, s, s', ev, hw, h => by
    simp only [mayWriteList, Bool.or_eq_false_iff] at hw
    simp only [evalChain] at h
    rcases hr : eval O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s with ⟨o, ev1⟩
    rw [hr] at h
    cases o with
    | ok s1 =>
      have h1 := frame O k hA n _ _ lp s s1 ev1 hw.1 hr
      simp only at h
      rcases hr2 : evalChain O ns (i + 1) path addr lp s1 with ⟨o2, ev2⟩
      rw [hr2] at h
      simp only [Prod.mk.injEq] at h; obtain ⟨rfl, -⟩ := h
      rw [frameChain O k hA ns (i + 1) path addr lp s1 s' ev2 hw.2 hr2, h1]
    | escalated _ | failed _ => simp at h
end

/-- **T2a (frame).** For every oracle, a completed run of `n` leaves every key outside
`mayWrite n` untouched, provided the host policy has no `afterNode` hook; `$host` is
untouched outside generative nodes even with one. -/
theorem T2_frame (O : Oracle) (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (s s' : State)
    (ev : List Event) (h : eval O n path addr lp s = (.ok s', ev)) (k : String) (hw : mayWrite n k = false)
    (hA : O.afterNode = none ∨ k = hostKey) : s'.get k = s.get k :=
  frame O k hA n path addr lp s s' ev hw h

end AgentRun
