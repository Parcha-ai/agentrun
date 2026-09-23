import AgentRunSemantics

/-!
# Axiom audit

Every theorem depends only on Lean's standard axioms (`propext`, `Classical.choice`,
`Quot.sound`): no `sorryAx`, and no `Lean.ofReduceBool` (the counterexamples use
`decide +kernel`, never `native_decide`). `#guard_msgs` fails the build if that changes.
-/

open AgentRun

/-- info: 'AgentRun.T1_requires_sound' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T1_requires_sound

/-- info: 'AgentRun.T1_as_stated_is_false' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T1_as_stated_is_false

/-- info: 'AgentRun.F1_untracked_after_code' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F1_untracked_after_code

/-- info: 'AgentRun.F1_tracked_but_empty' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F1_tracked_but_empty

/-- info: 'AgentRun.T2_frame' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T2_frame

/-- info: 'AgentRun.T2_parallel_no_domain_conflict' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T2_parallel_no_domain_conflict

/-- info: 'AgentRun.T2_merge_order_independent' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms T2_merge_order_independent

/-- info: 'AgentRun.T2_host_merge_order_dependent' depends on axioms: [propext] -/
#guard_msgs in
#print axioms T2_host_merge_order_dependent

/-- info: 'AgentRun.T2_host_scalar_then_array' depends on axioms: [propext] -/
#guard_msgs in
#print axioms T2_host_scalar_then_array

/-- info: 'AgentRun.T3_loop_ignores_late_iterations' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms T3_loop_ignores_late_iterations

/-- info: 'AgentRun.T3_loop_exit_count' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T3_loop_exit_count

/-- info: 'AgentRun.T3_loop_events' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T3_loop_events

/-- info: 'AgentRun.T3_runWorkflow_total' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T3_runWorkflow_total

/-- info: 'AgentRun.T4_eval_desugar' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T4_eval_desugar

/-- info: 'AgentRun.T4_validate_desugar' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T4_validate_desugar

/-- info: 'AgentRun.T4_runWorkflow_desugar' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms T4_runWorkflow_desugar

/-- info: 'AgentRun.F2_code_patches_collide' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F2_code_patches_collide

/-- info: 'AgentRun.F2_label_collides' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F2_label_collides

/-- info: 'AgentRun.F3_code_writes_dollar_key' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F3_code_writes_dollar_key

/-- info: 'AgentRun.F4_child_input_host' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F4_child_input_host

/-- info: 'AgentRun.F5_undefined_child_output' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F5_undefined_child_output

/-- info: 'AgentRun.F6_writes_beyond_as_or_label' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F6_writes_beyond_as_or_label

/-- info: 'AgentRun.F9_predicate_path_stops_at_arrays' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms F9_predicate_path_stops_at_arrays
