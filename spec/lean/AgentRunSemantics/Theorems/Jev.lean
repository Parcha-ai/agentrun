import AgentRunSemantics.Semantics

/-!
# Jev route policy

These theorems concern the workflow interpreter after a judgment has arrived. They
quantify over arbitrary branch bodies and oracles. They do not assert that a model
chose the correct business action or that its confidence is calibrated.
-/

namespace AgentRun

/-- The selected branch receives the original choice and the applied policy result. -/
def routePolicyState (s : State) (as : Option String) (choice taken : String)
    (unsure : Bool) (sidecar : Value) : State :=
  match as with
  | some k =>
    (s.set k (.obj [("branch", .str choice), ("taken", .str taken), ("unsure", .bool unsure)])).set
      (k ++ "$answers") sidecar
  | none => s

/-- Evaluation continues only through the named branch, or fails if it does not exist. -/
def routeContinuation (O : Oracle) (branches : List (String × Node)) (taken : String)
    (path : ExecPath) (addr : Addr) (lp label : String) (s : State) : Run :=
  let events := [evt path s!"route.chosen:{lp ++ label}:{taken}"]
  match evalNamed O branches taken path addr lp s with
  | some (outcome, rest) => (outcome, events ++ rest)
  | none => (.failed (.engine label "the taken branch does not exist"), events)

/-- Below a declared confidence threshold, the interpreter evaluates the fallback body.
No other branch body is evaluated by this route. The fallback body itself remains free
to contain arbitrary effects, child routes, or further model calls. -/
theorem jev_route_below_threshold
    (O : Oracle) (label : String) (st : Tmpl) (branches : List (String × Node))
    (fallback : String) (gte : Rat) (as : Option String) (requires : List Path)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State)
    (asked sidecar : Value) (choice : String) (confidence : Rat)
    (ready : checkRequires label addr s requires = .ok ())
    (prompt : promptState label s (some st) = .ok asked)
    (answer : O.route ⟨path, lp ++ label⟩ asked = .ok (choice, confidence, sidecar))
    (declared : (branchNames branches).contains choice = true)
    (below : confidence < gte) :
    eval O (.route label st branches (some (fallback, gte)) as requires) path addr lp s =
      routeContinuation O branches fallback path addr lp label
        (routePolicyState s as choice fallback true sidecar) := by
  simp only [List.contains_iff_mem] at declared
  simp [eval, ready, prompt, answer, declared, below, routeContinuation, routePolicyState]
  rfl

/-- Equality with the threshold uses the chosen branch, as do larger confidences.
Only the route's own answer controls this gate; unrelated sidecar values are arbitrary. -/
theorem jev_route_at_or_above_threshold
    (O : Oracle) (label : String) (st : Tmpl) (branches : List (String × Node))
    (fallback : String) (gte : Rat) (as : Option String) (requires : List Path)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State)
    (asked sidecar : Value) (choice : String) (confidence : Rat)
    (ready : checkRequires label addr s requires = .ok ())
    (prompt : promptState label s (some st) = .ok asked)
    (answer : O.route ⟨path, lp ++ label⟩ asked = .ok (choice, confidence, sidecar))
    (declared : (branchNames branches).contains choice = true)
    (enough : ¬ confidence < gte) :
    eval O (.route label st branches (some (fallback, gte)) as requires) path addr lp s =
      routeContinuation O branches choice path addr lp label
        (routePolicyState s as choice choice false sidecar) := by
  simp only [List.contains_iff_mem] at declared
  simp [eval, ready, prompt, answer, declared, enough, routeContinuation, routePolicyState]
  rfl

/-- An undeclared choice fails before a branch is evaluated, even with a fallback.
The TypeScript adapter also validates answers before this interpreter boundary. -/
theorem jev_route_undeclared_fails
    (O : Oracle) (label : String) (st : Tmpl) (branches : List (String × Node))
    (unsure : Option (String × Rat)) (as : Option String) (requires : List Path)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State)
    (asked sidecar : Value) (choice : String) (confidence : Rat)
    (ready : checkRequires label addr s requires = .ok ())
    (prompt : promptState label s (some st) = .ok asked)
    (answer : O.route ⟨path, lp ++ label⟩ asked = .ok (choice, confidence, sidecar))
    (undeclared : (branchNames branches).contains choice = false) :
    eval O (.route label st branches unsure as requires) path addr lp s =
      (.failed (.engine label "the choice names no branch"), []) := by
  have absent : choice ∉ branchNames branches := by simpa using undeclared
  simp [eval, ready, prompt, answer, absent]

end AgentRun
