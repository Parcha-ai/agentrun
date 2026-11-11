---
packages: @parcha/agentrun-serve
kind: feature
---
The `learned_workflow` tool's description, sent with every model request of a run that has learned workflows, is shorter: one line for what the tool does, then one line per workflow, its input's fields before what it does (`- answer {question* string}: Answers a question …`), with "* required" said once; its `name` and `input` parameters carry no words of their own. Nothing a model needs to call it is gone. For one workflow it adds 180 tokens to a request on gpt-5-4-mini instead of 216, and 635 on claude-haiku-4-5 instead of 678; for three workflows, 264 instead of 311, and 729 instead of 788.
Upgrading: nothing to do.
