---
packages: @parcha/pi-agent-learn
kind: fix
---
`learn` drops an id on a lesson, fact or correction that names no learning the run was given, and keeps the note without
it, instead of refusing the note; a blank id is no id on every type. A `used` mark with an unknown id is still refused, and
a `workflow` note's id keeps the DSL's name rule. Models that fill every optional field no longer lose a new note to a
made-up id.
