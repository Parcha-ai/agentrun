import AgentRunSemantics.Run

/-! # Lemmas about states, values and the interpreter's helpers -/

namespace AgentRun

theorem lookup_cons (k k' : String) (v : Value) (rest : List (String × Value)) :
    lookup k ((k', v) :: rest) = if k' = k then some v else lookup k rest := rfl

namespace State

@[simp] theorem get_nil (k : String) : State.get [] k = none := rfl

theorem get_set_self (s : State) (k : String) (v : Value) : (s.set k v).get k = some v := by
  induction s with
  | nil => simp [set, get, lookup]
  | cons p rest ih =>
    obtain ⟨k', v'⟩ := p
    by_cases h : k' = k
    · subst h; simp [set, get, lookup]
    · simp only [set, h, if_false]; simp only [get, lookup, h, if_false]; exact ih

theorem get_set_ne (s : State) {k k' : String} (v : Value) (h : k ≠ k') : (s.set k v).get k' = s.get k' := by
  induction s with
  | nil => simp [set, get, lookup, h]
  | cons p rest ih =>
    obtain ⟨j, w⟩ := p
    by_cases hj : j = k
    · subst hj; simp [set, get, lookup, h]
    · simp only [set, hj, if_false]; simp only [get, lookup] at *; by_cases hj' : j = k' <;> simp [hj', ih]

theorem get_set (s : State) (k k' : String) (v : Value) :
    (s.set k v).get k' = if k = k' then some v else s.get k' := by
  by_cases h : k = k'
  · subst h; simp [get_set_self]
  · simp [get_set_ne s v h, h]

theorem get_setAll_not_mem (s : State) (patch : List (String × Value)) (k : String)
    (h : ∀ p ∈ patch, p.1 ≠ k) : (s.setAll patch).get k = s.get k := by
  induction patch generalizing s with
  | nil => rfl
  | cons p rest ih =>
    show ((s.set p.1 p.2).setAll rest).get k = s.get k
    rw [ih (s.set p.1 p.2) (fun q hq => h q (List.mem_cons_of_mem _ hq))]
    exact get_set_ne s p.2 (h p (List.mem_cons_self ..))

theorem get_erase_ne (s : State) {k k' : String} (h : k ≠ k') : (s.erase k).get k' = s.get k' := by
  induction s with
  | nil => rfl
  | cons p rest ih =>
    obtain ⟨j, w⟩ := p
    simp only [erase, List.filter_cons] at *
    by_cases hj : j = k
    · subst hj
      have : j ≠ k' := h
      simp [get, lookup, this] at *; exact ih
    · simp [hj, get, lookup] at *; by_cases hj' : j = k' <;> simp [hj', ih]

theorem has_set (s : State) (k k' : String) (v : Value) (h : s.has k') : (s.set k v).has k' := by
  simp only [has] at *; rw [get_set]; split <;> simp_all

theorem has_set_self (s : State) (k : String) (v : Value) : (s.set k v).has k := by
  simp [has, get_set_self]

theorem has_setAll (s : State) (patch : List (String × Value)) (k : String) (h : s.has k) :
    (s.setAll patch).has k := by
  induction patch generalizing s with
  | nil => exact h
  | cons p rest ih =>
    show ((s.set p.1 p.2).setAll rest).has k
    exact ih _ (has_set s p.1 k p.2 h)

theorem has_of_mem_keys (s : State) (k : String) (h : k ∈ s.keys) : s.has k := by
  induction s with
  | nil => simp [keys] at h
  | cons p rest ih =>
    obtain ⟨j, w⟩ := p
    simp only [has, get, lookup]
    by_cases hj : j = k
    · simp [hj]
    · simp only [hj, if_false]
      simp only [keys, List.map_cons, List.mem_cons] at h
      rcases h with h | h
      · exact absurd h.symm hj
      · exact ih h

end State
end AgentRun
