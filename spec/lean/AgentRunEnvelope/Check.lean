import Lean
import AgentRunEnvelope

/-!
# Axiom audit and the frozen theorem set

Every theorem of the delivery model depends only on Lean's standard axioms (at most `propext`,
`Classical.choice` and `Quot.sound`): no `sorryAx`, and no `Lean.ofReduceBool`. `#guard_msgs` fails
the build if that changes.

The theorem set is frozen. The end of this file lists every theorem the package declares and checks
the axioms of each, so the build fails when a theorem is added, renamed or removed, or when any of
them reaches past the standard axioms.
-/

open AgentRunEnvelope

/-- info: 'AgentRunEnvelope.Gate.no_verdict_never_disagrees' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Gate.no_verdict_never_disagrees

/-- info: 'AgentRunEnvelope.Gate.gate_ignores_no_verdict' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Gate.gate_ignores_no_verdict

/-- info: 'AgentRunEnvelope.Gate.no_verdict_never_bounces' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Gate.no_verdict_never_bounces

/-- info: 'AgentRunEnvelope.Gate.after_round_accepts' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Gate.after_round_accepts

/-- info: 'AgentRunEnvelope.Gate.gate_terminates' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Gate.gate_terminates

/-- info: 'AgentRunEnvelope.Gate.step_counts_once' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Gate.step_counts_once

/-- info: 'AgentRunEnvelope.Gate.attempts_bounded' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Gate.attempts_bounded

/-- info: 'AgentRunEnvelope.Gate.session_terminates' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Gate.session_terminates

section Frozen
open Lean Elab Command

/-- The axioms a theorem of the model may depend on. -/
def standardAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- Every theorem declared in a module of this package, sorted by name. A `private theorem` is kept
    under its user-facing name (its axioms are read from the private declaration); auto-generated
    lemmas (internal names, or no declaration range) are left out. -/
def modelTheorems : CommandElabM (Array (Name × Name)) := do
  let env ← getEnv
  let mut out := #[]
  for (n, ci) in env.constants.map₁.toList do
    let some idx := env.getModuleIdxFor? n | continue
    unless (env.header.moduleNames[idx.toNat]!).getRoot == `AgentRunEnvelope do continue
    unless ci matches .thmInfo _ do continue
    let user := (privateToUserName? n).getD n
    if user.isInternal then continue
    unless (← findDeclarationRanges? n).isSome do continue
    out := out.push (user, n)
  return out.qsort (fun a b => Name.lt a.1 b.1)

-- Fails the build when a theorem of the model depends on an axiom outside `standardAxioms`.
run_cmd do
  for (n, decl) in ← modelTheorems do
    let extra := (← collectAxioms decl).toList.filter (!standardAxioms.contains ·)
    unless extra.isEmpty do logError m!"{n} depends on non-standard axioms: {extra}"

/-- info: 10 theorems
AgentRunEnvelope.Gate.after_round_accepts
AgentRunEnvelope.Gate.attempts_bounded
AgentRunEnvelope.Gate.ended_stays
AgentRunEnvelope.Gate.gate_ignores_no_verdict
AgentRunEnvelope.Gate.gate_terminates
AgentRunEnvelope.Gate.no_verdict_never_bounces
AgentRunEnvelope.Gate.no_verdict_never_disagrees
AgentRunEnvelope.Gate.progress
AgentRunEnvelope.Gate.session_terminates
AgentRunEnvelope.Gate.step_counts_once
-/
#guard_msgs in
run_cmd do
  let names ← modelTheorems
  logInfo m!"{names.size} theorems\n{"\n".intercalate (names.toList.map (toString ·.1))}"

end Frozen
