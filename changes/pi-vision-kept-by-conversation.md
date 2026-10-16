---
packages: @parcha/pi-vision
kind: fix
---
A paid look is kept on the conversation, not only on the tool call that paid for it: the pi-durable adapter keeps a tool call's `vision:look:<key>` answers and `vision:told:<key>` marks in a conversation document (`pi-vision.kept`), committed right after the answer, so a later call of the same conversation that asks the same finds it. On a host whose code-mode tool is not replay-safe, pi never runs a cut call again: a kill after the eyes answered and before the look was filed made the next script ask and pay again, and the first payment never reached the host. Now that call reads every answer back at $0, tells the host once of a look whose filing was cut, and again as kept of one it was already told. A hook's memos (the guard's) stay on its task.
