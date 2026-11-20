---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent's failure words cut the recipe's keys before they are shortened, so a cut that lands inside a key (the last 300 characters, or the start of the stderr tail the adapter keeps) leaves no piece of it.
