import AgentRunSemantics.Theorems.Writes

/-!
# T2 (parallel): disjoint branches never conflict, and the domain merge is order-free

Parallel branches run on isolated copies of the baseline and are merged afterwards
(`mergeParallel`). The theorems here are about that merge: with pairwise disjoint write
sets there is no domain `parallel_write_conflict`, and the merged domain state does not
depend on the order the branch results are combined in. `$host` merges by a different
rule, and two kernel-checked counterexamples show it is order-dependent.
-/

namespace AgentRun

def keysOf (l : List (String × Value)) : List String := l.map (·.1)

theorem dedup_nodup : ∀ l : List String, (State.dedup l).Nodup
  | [] => List.nodup_nil
  | k :: ks => by
    simp only [State.dedup, List.nodup_cons]
    exact ⟨by simp [List.mem_filter], (dedup_nodup ks).filter _⟩

theorem keys_filterMap (f : String → Option Value) : ∀ l : List String,
    keysOf (l.filterMap (fun k => (f k).map (k, ·))) = l.filter (fun k => (f k).isSome)
  | [] => rfl
  | k :: ks => by
    simp only [List.filterMap_cons, List.filter_cons]
    cases h : f k <;> simp [keysOf, ← keys_filterMap f ks]

theorem entries_nodup (s : State) : (keysOf s.entries).Nodup := by
  simp only [State.entries, keys_filterMap]
  exact (dedup_nodup _).filter _

theorem keysOf_filter_sublist (p : String × Value → Bool) (l : List (String × Value)) :
    (keysOf (l.filter p)).Sublist (keysOf l) := by
  simp only [keysOf]; exact (List.filter_sublist).map _

theorem patchOf_nodup (s o : State) : (keysOf (patchOf s o)).Nodup :=
  (entries_nodup o).sublist (keysOf_filter_sublist _ _)

/-! ## `mergePatch` / `mergePatches` specifications -/

theorem mergePatch_error : ∀ (p : List (String × Value)) (w : List String) (m : State) (k : String),
    mergePatch p w m = .error k → ¬ (w ++ keysOf p).Nodup
  | [], _, _, _, h => by simp [mergePatch] at h
  | (k', v) :: rest, w, m, k, h => by
    simp only [mergePatch] at h
    split at h
    · rename_i hc
      intro hn
      simp only [keysOf, List.map_cons, List.nodup_append, List.mem_cons] at hn
      exact hn.2.2 k' (by simpa using hc) k' (Or.inl rfl) rfl
    · have := mergePatch_error rest (k' :: w) (m.set k' v) k h
      intro hn; apply this
      have hp : (k' :: w ++ keysOf rest).Perm (w ++ keysOf ((k', v) :: rest)) := by
        simp only [keysOf, List.map_cons]; exact List.perm_middle.symm
      exact hp.nodup_iff.mpr hn

theorem mergePatch_ok : ∀ (p : List (String × Value)) (w w' : List String) (m m' : State),
    w.Nodup → mergePatch p w m = .ok (w', m') →
      w'.Perm (w ++ keysOf p) ∧ m' = m.setAll p ∧ (w ++ keysOf p).Nodup
  | [], w, w', m, m', hw, h => by
    simp only [mergePatch, Except.ok.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    simp [keysOf, State.setAll, hw]
  | (k', v) :: rest, w, w', m, m', hw, h => by
    simp only [mergePatch] at h
    split at h
    · simp at h
    · rename_i hc
      have hw' : (k' :: w).Nodup := List.nodup_cons.mpr ⟨by simpa using hc, hw⟩
      obtain ⟨hp, hm, hn⟩ := mergePatch_ok rest (k' :: w) w' (m.set k' v) m' hw' h
      have hperm : (k' :: w ++ keysOf rest).Perm (w ++ keysOf ((k', v) :: rest)) := by
        simp only [keysOf, List.map_cons]; exact List.perm_middle.symm
      exact ⟨hp.trans hperm, hm, hperm.nodup_iff.mp hn⟩

theorem mergePatch_total : ∀ (p : List (String × Value)) (w : List String) (m : State),
    (w ++ keysOf p).Nodup → ∃ w' m', mergePatch p w m = .ok (w', m')
  | [], w, m, _ => ⟨w, m, rfl⟩
  | (k', v) :: rest, w, m, hn => by
    have hperm : (k' :: w ++ keysOf rest).Perm (w ++ keysOf ((k', v) :: rest)) := by
      simp only [keysOf, List.map_cons]; exact List.perm_middle.symm
    have hn' := hperm.nodup_iff.mpr hn
    have hk : k' ∉ w := by
      intro hk; simp only [List.cons_append, List.nodup_cons, List.mem_append] at hn'; exact hn'.1 (Or.inl hk)
    simp only [mergePatch, show w.contains k' = false by simpa using hk]
    exact mergePatch_total rest (k' :: w) (m.set k' v) hn'

theorem mergePatches_ok : ∀ (ps : List (List (String × Value))) (w : List String) (m m' : State),
    w.Nodup → mergePatches ps w m = .ok m' → (w ++ keysOf ps.flatten).Nodup ∧ m' = m.setAll ps.flatten
  | [], w, m, m', hw, h => by
    simp only [mergePatches, Except.ok.injEq] at h; subst h; simp [keysOf, State.setAll, hw]
  | p :: ps, w, m, m', hw, h => by
    simp only [mergePatches] at h
    split at h
    · rename_i w1 m1 h1
      obtain ⟨hp, hm, hn⟩ := mergePatch_ok p w w1 m m1 hw h1
      obtain ⟨hn2, hm2⟩ := mergePatches_ok ps w1 m1 m' (hp.nodup_iff.mpr hn) h
      refine ⟨?_, ?_⟩
      · have : (w1 ++ keysOf ps.flatten).Perm (w ++ keysOf (p :: ps).flatten) := by
          simp only [List.flatten_cons, keysOf, List.map_append, ← List.append_assoc]
          exact hp.append_right _
        exact this.nodup_iff.mp hn2
      · rw [hm2, hm]; simp [State.setAll, List.foldl_append]
    · simp at h

theorem mergePatches_total : ∀ (ps : List (List (String × Value))) (w : List String) (m : State),
    (w ++ keysOf ps.flatten).Nodup → ∃ m', mergePatches ps w m = .ok m'
  | [], _, m, _ => ⟨m, rfl⟩
  | p :: ps, w, m, hn => by
    have hn1 : (w ++ keysOf p).Nodup := by
      simp only [List.flatten_cons, keysOf, List.map_append, ← List.append_assoc] at hn
      exact hn.sublist (List.sublist_append_left _ _)
    obtain ⟨w1, m1, h1⟩ := mergePatch_total p w m hn1
    have hw : w.Nodup := hn1.sublist (List.sublist_append_left _ _)
    obtain ⟨hp, _, _⟩ := mergePatch_ok p w w1 m m1 hw h1
    simp only [mergePatches, h1]
    apply mergePatches_total ps w1 m1
    have : (w1 ++ keysOf ps.flatten).Perm (w ++ keysOf (p :: ps).flatten) := by
      simp only [List.flatten_cons, keysOf, List.map_append, ← List.append_assoc]
      exact hp.append_right _
    exact this.nodup_iff.mpr hn

/-- The domain merge succeeds exactly when no key appears in two patches. -/
theorem mergePatches_ok_iff (ps : List (List (String × Value))) (m : State) :
    (∃ m', mergePatches ps [] m = .ok m') ↔ (keysOf ps.flatten).Nodup := by
  constructor
  · rintro ⟨m', h⟩; simpa using (mergePatches_ok ps [] m m' List.nodup_nil h).1
  · intro h; exact mergePatches_total ps [] m (by simpa using h)

/-! ## Lookups are invariant under permutation of a list with distinct keys -/

theorem lookup_perm (k : String) {l l' : List (String × Value)} (hp : l.Perm l') :
    (keysOf l).Nodup → lookup k l = lookup k l' := by
  induction hp with
  | nil => intro; rfl
  | cons x _ ih =>
    intro hn
    obtain ⟨a, b⟩ := x
    simp only [lookup]
    split
    · rfl
    · exact ih (List.nodup_cons.mp (by simpa [keysOf] using hn)).2
  | swap x y l =>
    intro hn
    obtain ⟨a, b⟩ := y; obtain ⟨c, d⟩ := x
    simp only [keysOf, List.map_cons, List.nodup_cons, List.mem_cons] at hn
    simp only [lookup]
    by_cases hc : c = k <;> by_cases ha : a = k
    · subst hc; subst ha; exact absurd rfl (fun h => hn.1 (Or.inl h))
    · simp [hc, ha]
    · simp [hc, ha]
    · simp [hc, ha]
  | trans h1 _ ih1 ih2 =>
    intro hn
    rw [ih1 hn, ih2 ((h1.map (fun x : String × Value => x.1)).nodup_iff.mp hn)]

theorem setAll_get_nodup : ∀ (m : State) (l : List (String × Value)) (k : String), (keysOf l).Nodup →
    (m.setAll l).get k = (match lookup k l with | some v => some v | none => m.get k)
  | m, [], k, _ => rfl
  | m, (k', v) :: rest, k, hn => by
    have hn' : k' ∉ keysOf rest ∧ (keysOf rest).Nodup := List.nodup_cons.mp hn
    show ((m.set k' v).setAll rest).get k = _
    rw [setAll_get_nodup (m.set k' v) rest k hn'.2]
    simp only [lookup]
    by_cases hk : k' = k
    · subst hk
      have : lookup k' rest = none := by
        cases h : lookup k' rest with
        | none => rfl
        | some w =>
          exfalso; apply hn'.1
          have := lookup_isSome_of_mem' k' rest h
          simpa [keysOf] using this
      simp [this, State.get_set_self]
    · simp only [hk, if_false]
      cases lookup k rest <;> simp [State.get_set_ne m v hk]
where
  lookup_isSome_of_mem' (k : String) : ∀ (l : List (String × Value)) {w : Value}, lookup k l = some w → k ∈ l.map (·.1)
    | [], _, h => by simp [lookup] at h
    | (a, b) :: rest, w, h => by
      simp only [lookup] at h
      split at h
      · rename_i ha; simp [ha]
      · simp [lookup_isSome_of_mem' k rest h]


/-! ## T2b: disjoint write sets never conflict; T2c: the domain merge is order-independent -/

theorem all_ok_eq : ∀ rs : List Outcome, (rs.filter (!·.isOk)).isEmpty = true →
    rs = (rs.filterMap fun | .ok s => some s | _ => none).map Outcome.ok
  | [], _ => rfl
  | r :: rest, h => by
    cases r with
    | ok s =>
      have h' : (rest.filter (!·.isOk)).isEmpty = true := by
        simpa [Outcome.isOk] using h
      simp only [List.filterMap_cons, List.map_cons]
      exact congrArg _ (all_ok_eq rest h')
    | escalated _ | failed _ => simp [List.filter_cons, Outcome.isOk] at h

theorem gather_ok_eq (O : Oracle) (rs : List Outcome) (outs : List State)
    (h : gather O rs = .ok outs) : rs = outs.map Outcome.ok := by
  unfold gather at h; dsimp only at h
  split at h
  · rename_i hne
    simp only [Except.ok.injEq] at h; subst h
    exact all_ok_eq rs hne
  · simp at h

theorem patch_key_mayWrite (O : Oracle) (hA : O.afterNode = none) (b : Node) (path : ExecPath) (addr : Addr)
    (lp : String) (s o : State) (ev : List Event) (h : eval O b path addr lp s = (.ok o, ev))
    (k : String) (hk : k ∈ keysOf (patchOf s o)) : mayWrite b k = true ∧ k ≠ hostKey := by
  obtain ⟨kv, hkv, rfl⟩ := List.mem_map.mp hk
  refine ⟨?_, patchOf_no_host s o kv hkv⟩
  cases hw : mayWrite b kv.1 with
  | true => rfl
  | false =>
    exact absurd rfl (patchOf_not_mem s o kv.1 (frame O kv.1 (Or.inl hA) b path addr lp s o ev hw h) kv hkv)

/-- Write sets of two branches that share no key except `$host`. -/
def DisjointWrites (b b' : Node) : Prop := ∀ k, k ≠ hostKey → ¬(mayWrite b k = true ∧ mayWrite b' k = true)

theorem branch_patches (O : Oracle) (hA : O.afterNode = none) :
    ∀ (bs : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State) (outs : List State),
      (evalBranches O bs i path addr lp s).map (·.1) = outs.map Outcome.ok →
      bs.Pairwise DisjointWrites →
      (keysOf (outs.map (patchOf s)).flatten).Nodup ∧
        ∀ k ∈ keysOf (outs.map (patchOf s)).flatten, k ≠ hostKey ∧ ∃ b ∈ bs, mayWrite b k = true
  | [], _, _, _, _, _, outs, h, _ => by
    cases outs with
    | nil => simp [keysOf]
    | cons _ _ => simp [evalBranches] at h
  | b :: bs, i, path, addr, lp, s, outs, h, hp => by
    cases outs with
    | nil => simp [evalBranches] at h
    | cons o os =>
      simp only [evalBranches, List.map_cons, List.cons.injEq] at h
      obtain ⟨h1, h2⟩ := h
      obtain ⟨hn, hks⟩ := branch_patches O hA bs (i + 1) path addr lp s os h2 (List.pairwise_cons.mp hp).2
      have hb : eval O b (path ++ ["branches", seg i]) (addr ++ [.branch i]) lp s =
          (.ok o, (eval O b (path ++ ["branches", seg i]) (addr ++ [.branch i]) lp s).2) := by
        rw [← h1]
      have hpk := patch_key_mayWrite O hA b _ _ lp s o _ hb
      simp only [List.map_cons, List.flatten_cons, keysOf, List.map_append] at hn hks ⊢
      refine ⟨List.nodup_append.mpr ⟨patchOf_nodup s o, hn, ?_⟩, ?_⟩
      · intro k hk k' hk' heq; subst heq
        obtain ⟨hw, hne⟩ := hpk k hk
        obtain ⟨-, b', hb', hw'⟩ := hks k hk'
        exact (List.pairwise_cons.mp hp).1 b' hb' k hne ⟨hw, hw'⟩
      · intro k hk
        rcases List.mem_append.mp hk with hk | hk
        · obtain ⟨hw, hne⟩ := hpk k hk
          exact ⟨hne, b, List.mem_cons_self .., hw⟩
        · obtain ⟨hne, b', hb', hw'⟩ := hks k hk
          exact ⟨hne, b', List.mem_cons_of_mem _ hb', hw'⟩

/-- **T2b.** If no two branches may write the same key (other than `$host`), a parallel
node whose branches all complete never fails with a domain `parallel_write_conflict`,
for every oracle without `afterNode`. (`$host` merges separately; see
`T2_host_merge_order_dependent`.) -/
theorem T2_parallel_no_domain_conflict (O : Oracle) (hA : O.afterNode = none) (label : String) (bs : List Node)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State) (outs : List State)
    (hdisj : bs.Pairwise DisjointWrites)
    (hg : gather O ((evalBranches O bs 0 path addr lp s).map (·.1)) = .ok outs) (k : String) :
    mergeParallel label s outs ≠ .failed (.state .parallelWriteConflict label [k]) := by
  have hn := (branch_patches O hA bs 0 path addr lp s outs (gather_ok_eq O _ outs hg) hdisj).1
  unfold mergeParallel; dsimp only
  split
  · simp
  · rename_i acc _
    obtain ⟨m, hm⟩ := (mergePatches_ok_iff (outs.map (patchOf s))
      (if acc.changed = true then s.set hostKey (.obj acc.merged) else s)).mpr hn
    rw [hm]; simp

/-- **T2c.** The domain merge does not depend on the order in which branch results are
combined: success or failure, and every key of the merged state, are invariant under
any permutation of the branch results. Branches run on isolated copies of the baseline,
so this is the only place an interleaving could matter. -/
theorem T2_merge_order_independent (base m0 : State) (outs outs' : List State) (hp : outs.Perm outs') :
    ((∃ m, mergePatches (outs.map (patchOf base)) [] m0 = .ok m) ↔
      (∃ m, mergePatches (outs'.map (patchOf base)) [] m0 = .ok m)) ∧
    ∀ m m', mergePatches (outs.map (patchOf base)) [] m0 = .ok m →
      mergePatches (outs'.map (patchOf base)) [] m0 = .ok m' → ∀ k, m.get k = m'.get k := by
  have hf := (hp.map (patchOf base)).flatten
  have hk : (keysOf (outs.map (patchOf base)).flatten).Perm (keysOf (outs'.map (patchOf base)).flatten) :=
    hf.map _
  refine ⟨by rw [mergePatches_ok_iff, mergePatches_ok_iff]; exact hk.nodup_iff, ?_⟩
  intro m m' h h' k
  obtain ⟨hn, rfl⟩ := mergePatches_ok _ [] m0 m List.nodup_nil h
  obtain ⟨hn', rfl⟩ := mergePatches_ok _ [] m0 m' List.nodup_nil h'
  simp only [List.nil_append] at hn hn'
  rw [setAll_get_nodup _ _ _ hn, setAll_get_nodup _ _ _ hn', lookup_perm k hf hn]

/-! ## `$host` merges are not order-independent (findings, checked by the kernel) -/

def hostDelta (k : String) (v : Value) : State := [(hostKey, .obj [(k, v)])]

/-- **Finding.** Two branches appending to the same `$host` array merge in branch order:
swapping the branches reorders the merged value. -/
theorem T2_host_merge_order_dependent :
    mergeParallel "p" [] [hostDelta "log" (.arr [.str "a"]), hostDelta "log" (.arr [.str "b"])] =
      .ok [(hostKey, .obj [("log", .arr [.str "a", .str "b"])])] ∧
    mergeParallel "p" [] [hostDelta "log" (.arr [.str "b"]), hostDelta "log" (.arr [.str "a"])] =
      .ok [(hostKey, .obj [("log", .arr [.str "b", .str "a"])])] := by
  constructor <;> rfl

/-- **Finding.** A scalar `$host` write followed by an array write to the same new key is
silently replaced by the array; in the other branch order it is a write conflict. -/
theorem T2_host_scalar_then_array :
    mergeParallel "p" [] [hostDelta "k" (.str "scalar"), hostDelta "k" (.arr [.str "x"])] =
      .ok [(hostKey, .obj [("k", .arr [.str "x"])])] ∧
    mergeParallel "p" [] [hostDelta "k" (.arr [.str "x"]), hostDelta "k" (.str "scalar")] =
      .failed (.state .parallelWriteConflict "p" [hostKey, "k"]) := by
  constructor <;> rfl

end AgentRun
