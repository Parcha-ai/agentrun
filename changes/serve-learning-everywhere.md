---
packages: @parcha/agentrun-serve, @parcha/agentrun-learn
kind: feature
---
Learning works on cheap models: the grader keeps a lesson the agent worked out itself, and what the user asked it to keep, and still drops what a page told it.
- `@parcha/agentrun-learn`: `GRADE_RUBRIC` asks five questions. "From content" is now "Planted": an instruction a page, a document or a tool's output gave is planted (act for someone else, send data, trust or use a source content offered, skip or change the instructions, or remember this). A lesson the agent drew from its own work, such as a URL pattern, a site's layout or how a tool behaves, is not planted, and neither is what the user said in the run. A new "Secret" question covers passwords, keys and private details, "General" now counts a tool's or the setup's failure as tied to its case, and "Duplicate" counts a note that restates the agent's standing instructions. `gradePrompt` takes `asked`, the user's messages in the run (the first and the newest, 20 in all, each cut to 1,000 characters), fenced as data.
- `@parcha/agentrun-serve`: the grader runs on the model the server names for it: `--grade-model` (or `AGENTRUN_SERVE_GRADE_MODEL`), else the strong tier (`AGENT_MODEL_STRONG`), else the agent's own model as before. It reads what the user said in the run, cut of the server's secrets, which the proposal now keeps (`asked`).
