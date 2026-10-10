import Lean
import AgentRunRecovery

/-!
# Axiom audit and the theorem set of the recovery model

Every theorem depends only on Lean's standard axioms (`propext`, `Classical.choice`, `Quot.sound`):
no `sorryAx`, and no `Lean.ofReduceBool`. `#guard_msgs` fails the build if that changes.

The end of this file lists every theorem the library declares, so the build fails when a theorem is
added, renamed or removed without this list changing with it. Lean counts a structure's `Prop` fields as
theorems: six of the seventeen names are the fields of `Frozen.Inv` (`at_most_once`, `behind_completed`,
`completed_once`, `flight_sent`, `fresh_unsent`, `none_unsent`), stated by the structure and proved
wherever an `Inv` is built (`inv_init`, `inv_step`). The other eleven are theorems proper.
-/

open AgentRunRecovery

/-- info: 'AgentRunRecovery.Frozen.admit_before_dispatch' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Frozen.admit_before_dispatch

/-- info: 'AgentRunRecovery.Frozen.one_dispatch_per_effect' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Frozen.one_dispatch_per_effect

/-- info: 'AgentRunRecovery.Frozen.completed_dispatched_once' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Frozen.completed_dispatched_once

/-- info: 'AgentRunRecovery.Frozen.completed_never_redispatched' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Frozen.completed_never_redispatched

/-- info: 'AgentRunRecovery.Frozen.admitted_elsewhere_never_resent' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Frozen.admitted_elsewhere_never_resent

/-- info: 'AgentRunRecovery.Frozen.never_past_uncompleted' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms Frozen.never_past_uncompleted

/-- info: 'AgentRunRecovery.Frozen.resume_answers_completed' depends on axioms: [propext] -/
#guard_msgs in
#print axioms Frozen.resume_answers_completed

section TheoremSet
open Lean Elab Command

/-- The axioms a theorem of the model may depend on. -/
def standardAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- Every theorem declared in a module of this library, sorted by name. A `private theorem` is kept under its
    user-facing name (its axioms are read from the private declaration); auto-generated lemmas (internal names, or no
    declaration range) are left out. -/
def modelTheorems : CommandElabM (Array (Name × Name)) := do
  let env ← getEnv
  let mut out := #[]
  for (n, ci) in env.constants.map₁.toList do
    let some idx := env.getModuleIdxFor? n | continue
    unless (env.header.moduleNames[idx.toNat]!).getRoot == `AgentRunRecovery do continue
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

/-- info: 17 theorems
AgentRunRecovery.Frozen.admit_before_dispatch
AgentRunRecovery.Frozen.admitted_elsewhere_never_resent
AgentRunRecovery.Frozen.completed_dispatched_once
AgentRunRecovery.Frozen.completed_never_redispatched
AgentRunRecovery.Frozen.held_step
AgentRunRecovery.Frozen.inv_init
AgentRunRecovery.Frozen.inv_reach
AgentRunRecovery.Frozen.inv_step
AgentRunRecovery.Frozen.never_past_uncompleted
AgentRunRecovery.Frozen.one_dispatch_per_effect
AgentRunRecovery.Frozen.resume_answers_completed
AgentRunRecovery.Frozen.Inv.at_most_once
AgentRunRecovery.Frozen.Inv.behind_completed
AgentRunRecovery.Frozen.Inv.completed_once
AgentRunRecovery.Frozen.Inv.flight_sent
AgentRunRecovery.Frozen.Inv.fresh_unsent
AgentRunRecovery.Frozen.Inv.none_unsent
-/
#guard_msgs in
run_cmd do
  let names ← modelTheorems
  logInfo m!"{names.size} theorems\n{"\n".intercalate (names.toList.map (toString ·.1))}"

end TheoremSet
