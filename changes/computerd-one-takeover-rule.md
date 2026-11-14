---
packages: repo
kind: fix
---
Computerd's `input.actions` stops with `aborted` when a person presses a key during a batch, not only when they move the pointer: a batch and a `ui.act` keep one take-over rule (the person's keyboard or mouse used since the call began, or the pointer moved from where Computerd left it), in the same words, and the batch's own posted events never count.
