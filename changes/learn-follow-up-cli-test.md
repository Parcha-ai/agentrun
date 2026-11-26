---
packages: @parcha/agentrun-serve
kind: ci
---
A test now covers a follow-up correction on claude-agent: a correction sent to a finished run as a follow-up is saved to `corrections.md`, and the agent's next run gets it under `# Learned` in the system prompt its model receives. Until now only pi had this test. The cases also cover each run in a process of its own, a spend cap with a model key on the start and on the message, an end whose census was not made, and a follow-up's key revoked once it answered. CI's Postgres job runs every case on Postgres as well.
