---
packages: @parcha/agentrun-serve
kind: feature
---
A grade is now the way a label reaches a run's learning, and a label never makes the agent answer the job again. `PUT /runs/{id}/grade` takes `label` (the grade's words, up to 4000 characters) and answers `feedback`: a right grade of a run its learned workflow answered alone is kept and nothing more (`null`, no model request, $0); a wrong one opens the run again on a revision ask for that workflow (`revise`): the agent's end-of-run turn alone, told the job, the workflow's answer and the label; a run the agent finished, graded with a `label`, opens again on a look-back on it (`look_back`). Neither round runs a turn of the job's; the label shows on the run's Timeline as the reviewer's message.
A run's path is who wrote its final answer: a run its learned workflow answered stays `workflow` after a feedback round or a follow-up that ends on the same answer, and turns `handed_back` only when the agent writes a new or changed one.
The cost per run (`GET /agents/{id}/learning/cost`) counts every round of a run a follow-up or a grade opened again: the job is what the run cost when its first round answered, and everything after it (each later round's turns and every round's look-back) is its `learning_usd`. It read the newest round's look-back alone and counted a follow-up's turn as the job's.
Upgrading: a client that sent a label as a follow-up message (`POST /runs/{id}/messages`) sends it as the grade's `label` instead.
