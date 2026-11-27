---
packages: @parcha/agentrun-serve
kind: fix
---
A grade's words now reach the compile of the round they open. When a grade with words opens a correction round and a compile is due in it, every attempt of that compile is told the words as a correction, beside the owner's other corrections. Before, the compile was asked without them, and the words reached only later runs through `corrections.md`. Words the checks refuse (a secret, a hidden character, a line past the cap) are still never told.
