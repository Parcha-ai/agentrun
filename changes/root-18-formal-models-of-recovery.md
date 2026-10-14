---
packages: repo
kind: docs
---
Formal models of recovery. `spec/receipts/Receipts.tla` (TLA+) and `spec/lean/AgentRunRecovery/Frozen.lean` (Lean) state what a recovery driver does with effects over a `RecoveryJournal` across crashes and failed commits: admitted before dispatch, one dispatch per effect, a completed effect answered and an unknown one refused on resume, nothing admitted after a failed commit. TLC checks seven properties on two configs, nine guard mutants must each be caught by its named property, and Lean proves the driver's properties for every number of steps and crashes. A new `receipts-spec` CI job runs the TLA+ checks when a change touches the spec, and a nightly workflow runs them on `main`. AGENTS.md and CONTRIBUTING.md add the rule: a change to modeled behavior changes the model in the same pull request.
