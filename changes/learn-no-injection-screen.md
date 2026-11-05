---
packages: @parcha/agentrun-serve
kind: fix
---
Learning no longer drops a preference you asked an agent to remember on a server with a Jev key. With `TYPESAFE_API_KEY` set, each new note went through a page-injection classifier before the grader, and a stated preference ("always answer in tables") reads like an instruction to it, so it was dropped as "Not kept: a new note read like instructions planted in a page, not a lesson." The classifier cannot see where a note came from. That screen is gone: the grader's Planted question decides, with what the user said in the run in view. The `screen` and `screen_down` reasons are no longer produced; older runs that hold them still read. One grader now judges every new note, skill and draft: with no `--grade-model` (and no `AGENT_MODEL_STRONG`), that is the agent's own model, the only judge of what it learns. When learning is on, name a strong grade model.
