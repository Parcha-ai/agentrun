---
packages: @parcha/agentrun-serve
kind: ci
---
**The webhook test for a redelivery in flight no longer races the server's 15 s fetch timeout on a loaded machine**
- The test held a redelivery unanswered while it made 50 more test sends, each writing the outbox to disk twice. On a loaded machine those sends could outlast the 15 s a try waits for an answer, so the held redelivery failed as "no answer in 15 s" and the test with it.
- It now fills the attempt log first, then holds the redelivery while a single send pushes the message's first attempt out of the log. It checks the same things, and that the outbox on disk still keeps the message while its redelivery waits.
