---
packages: repo
kind: ci
---
serve's OpenCode test of twenty follow-ups on one port is quarantined on CI for 24 hours (F36, owner tl-jobs): it went red twice on 11-05 on pull requests that don't touch OpenCode, once ejecting a merge-queue run. It still runs locally, and with AGENTRUN_RUN_QUARANTINED=1 on CI.
