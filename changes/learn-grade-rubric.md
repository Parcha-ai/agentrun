---
packages: @parcha/agentrun-learn
kind: feature
---
`GRADE_RUBRIC`, `gradePrompt({ run, instructions, index, changes })` and `parseVerdict(text, changes)`: the grade step of the merge policy, as a library. `GRADE_RUBRIC` is the rubric's one statement, the questions a grader asks of each new or changed note, skill and workflow draft against `main`'s index and notes and the agent's standing instructions. `gradePrompt` builds the grader's prompt, each file fenced as data behind a token no fenced text holds, and asks for one JSON verdict. `parseVerdict` reads it and fails closed: the branch merges only when the grader said merge and kept every item, and two objects, a missing, doubled or unknown item, or an answer it cannot read is no merge. Neither calls a model or runs git.
