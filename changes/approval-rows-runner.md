---
packages: @parcha/agentrun-serve
kind: fix
---
A call that waited for approval reads in order on the Timeline again once it has run. First come its own rows ("Held for your approval"), then your approval, then what came of it. Before, the approval row stayed above the call's result after an Allow, and with a second call waiting it read out of order. An allowed write no longer shows its own "Saved <path>" row; the outcome row says it ran. A message you send while a call waits declines the call and now shows as your own row ("You: …") below the outcome, with your words through the run's redaction.
