---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent's failure words cut the recipe's keys before they are shortened, so a cut that lands inside a key (the last 300 characters, the start of the stderr tail the adapter keeps, or its end while the agent is still writing a key) leaves no piece of it, even where two keys overlap.
