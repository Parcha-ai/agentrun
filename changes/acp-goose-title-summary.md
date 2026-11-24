---
packages: @parcha/agentrun-harness-acp
kind: fix
---
A Goose 1.59.2 call of one of AgentRun's tools whose title carries Goose's summary of its arguments (`agentrun: write · proof.txt`) is now tied to that tool. Before, it reached the tool gate as Goose's own call (`acp_other`) and waited for an approval, so a write the agent was allowed to make stopped the run at input_required. The title alone still ties nothing: the call needs the tool_call Goose announced for it, and a kind with effects of its own (a shell, an edit) is never ours.
