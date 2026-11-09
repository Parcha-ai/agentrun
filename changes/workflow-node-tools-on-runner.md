---
packages: @parcha/agentrun-pi, @parcha/agentrun-serve
kind: fix
---
A workflow's model node submits on the runner. Every model request on the runner goes through the session's model proxy, whose policy drops each tool definition it is not given, and a workflow's proxy was given none: a node's request reached its model with no `submit`, so no workflow could finish there. The workflow's proxy now admits the node's whole offered set by name, its `submit` and the tools its workflow's model nodes name, on Anthropic's Messages and OpenAI's Responses alike, as a pi session's proxy admits its own tools. agentrun-pi exports the tool's name as `SUBMIT_TOOL`.
