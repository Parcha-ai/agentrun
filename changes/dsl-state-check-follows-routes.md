---
packages: @parcha/agentrun-dsl
kind: fix
---
Validation with input keys now refuses a state read that a run would refuse, inside a route's branches and past route and parallel nodes. Before, the state check stood down there: a `{url}` that nothing produced passed `validateWorkflow` (and so inspection) and failed the run with `interpolation path "url" is not present in the state`, while the same read at the top level was refused. The check now holds what each point of the run holds:
- inside a route branch, the state before the route plus the route's `as` (and `<as>$answers` for a route Jev chooses);
- after a route, only the keys every branch writes, since one of them runs;
- after a parallel, what each branch writes, since all of them run.

It still stands down after a code node, a map or a loop, as before.

A workflow that read, after a route, a key only some branches write is now refused at validation, where before it failed at run time through a branch that does not write it. Write the key on every branch, or read it inside the branch that writes it.
