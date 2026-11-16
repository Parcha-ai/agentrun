---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A learned workflow is asked for a revision only when its promotion record holds it, once per hold. A hand-back, a stop by the money rule and a wrong grade of a served run no longer each ask a compile turn: one bad case is one sample, and the hold (a replay under the bar, or graded runs under the agent's accuracy) reads it among the workflow's others. The first compile is still asked as before.
  - A wrong grade of a run its learned workflow answered opens no feedback round. The grade is kept (PUT /runs/{id}/grade answers `feedback: null`), and the graded hold, replay and refit read it. The `revise` feedback round is gone; `look_back` is the only one.
  - The money rule still stops a workflow that costs more than the agent and may hold it. The stop asks for no compile; the agent takes the run.
  - An agent run of an agent with `learning: true` asks no look-back turn unless its owner gave feedback on it: a grade's words, or a message after the run's first. A run without it spends $0 looking back and keeps its learning dropped `empty`, saying it looks back only on feedback. A compile that is due is still asked. `learning: "notes"` runs look back as before. An SDK run carries no owner feedback, so an SDK agent with `learning: true` learns through its compile turn alone.
  - A new draft's compile ask no longer asks for Jev guards by default: every judgment step is asked for a `self` guard, whether or not the run can call Jev.
  - Upgrading: a workflow agent's runs stop looking back on their own; give feedback (a grade with words, or a follow-up message) on the runs it should learn from. A client that read `feedback: "revise"` on a grade reads `null` for a served run now.
