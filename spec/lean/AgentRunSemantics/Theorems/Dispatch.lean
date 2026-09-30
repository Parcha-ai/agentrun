import AgentRunSemantics.Semantics

namespace AgentRun

/-- A declared string selects its own branch even when a fallback exists. -/
theorem dispatch_declared_string (s : State) (vp : Path) (names : List String)
    (value : String) (otherwise : Option String)
    (found : getPathS s vp = some (.str value)) (declared : names.contains value = true) :
    dispatchChoice s vp names otherwise = .ok (.str value, value, false) := by
  simp only [List.contains_iff_mem] at declared
  simp [dispatchChoice, found, declared]

/-- A missing value takes only the explicitly named fallback. -/
theorem dispatch_missing_fallback (s : State) (vp : Path) (names : List String)
    (fallback : String) (missing : getPathS s vp = none) :
    dispatchChoice s vp names (some fallback) = .ok (.null, fallback, true) := by
  simp [dispatchChoice, missing]

/-- A missing value without a fallback fails deterministically. -/
theorem dispatch_missing_fails (s : State) (vp : Path) (names : List String)
    (missing : getPathS s vp = none) :
    dispatchChoice s vp names none = .error .dispatchMissing := by
  simp [dispatchChoice, missing]

/-- After mechanical checks, evaluation enters only the selected named continuation.
No semantic oracle is queried by dispatch; the selected body can perform arbitrary work. -/
theorem dispatch_selected_continuation
    (O : Oracle) (label : String) (vp : Path) (branches : List (String × Node))
    (otherwise as : Option String) (requires : List Path)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State)
    (value : Value) (taken : String) (fallback : Bool)
    (ready : checkRequires label addr s requires = .ok ())
    (selected : dispatchChoice s vp (branchNames branches) otherwise = .ok (value, taken, fallback)) :
    eval O (.dispatch label vp branches otherwise as requires) path addr lp s =
      let state := match as with
        | some k => s.set k (.obj [("value", value), ("taken", .str taken), ("fallback", .bool fallback)])
        | none => s
      let events := [evt path s!"dispatch.chosen:{lp ++ label}:{taken}"]
      match evalNamed O branches taken path addr lp state with
        | some (outcome, rest) => (outcome, events ++ rest)
        | none => (.failed (.engine label "the taken branch does not exist"), events) := by
  simp only [eval, ready, selected]
  rfl

end AgentRun
