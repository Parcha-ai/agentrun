---
packages: repo
kind: fix
---
Every dropdown in the console is its own picker, the one the Playground uses, where several were the browser's native select, which a phone opens as a full-height list of its own. That covers the Runs state filter, Mission Control's agent, the run bar's effort, Settings → Tools' and an agent's Tool settings' permission and provider, and a schedule's unit and agent. Each keeps its name, its keyboard (arrows, Home and End, Enter, Esc, typing to jump), and its disabled state. A permission that can't be picked here (ask, where no one can approve) is offered disabled with why. A schedule's form still carries its unit and agent by name. A test fails on any native select in the console's source.
