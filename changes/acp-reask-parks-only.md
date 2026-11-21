---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent (Cursor) that skipped a command the person allowed no longer has its turn cut after three more commands its tool setting allows: only commands that wait for the person count toward `REASK_LIMIT`. An allow-once is now used once: if a later agent process in the same turn asks for the same command again, the person is asked again instead of the old allow running it a second time.
