---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow's check now judges each `agree_on` field (else the whole answer) against a grade's expected answer where one exists, else the agent's answer, and a hold names the fields that failed and the known answers the draft missed.
