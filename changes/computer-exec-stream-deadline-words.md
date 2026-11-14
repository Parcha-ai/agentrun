---
packages: @parcha/agentrun-computer
kind: fix
---
The exec pre-check's `large` check names its deadline when a write runs out of it ("writing … ran past 1 s, with N bytes written"), even when the write's timer fires a millisecond before the clock reads the deadline. It used to say the write "did not answer within 0.2 s" in that case, which named the wrong bound and made its test flaky in CI.
A write the caller stops (an aborted run) says it was stopped, with the bytes written, and names no bound.
