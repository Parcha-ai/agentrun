---
packages: @parcha/agentrun-serve
kind: fix
---
A person's take-over of a run's desktop or phone now ends in words when the run changes runner. Until now, when the runner holding the run lost its claim during a take (it crashed, or its lease ran out), its end of the take was refused with the claim, and the runner that took the run over started a new computer with the agent driving: the take vanished from the run, with no row saying why. The new claim now ends that take `released`, once, with the Timeline row "The desktop's session ended while you had it" (or the phone's), as the earlier computer is let go; a hand-back of that take is refused in those words.
