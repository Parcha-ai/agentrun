---
name: nightly
version: 1.0.0
description: Writes a short brief on a topic, every morning.
model: { tier: strong }
parameters:
  topic: { type: string, required: true, description: what the brief is about }
  words: { type: integer, description: how long the brief is }
secrets: [PARALLEL_API_KEY]
budget: { per_run_usd: 0.25 }
triggers:
  - name: Morning brief
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Today's brief on ${parameters.topic}." } }
---
Write a brief of about ${parameters.words} words on ${parameters.topic}.
