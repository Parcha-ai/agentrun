---
packages: repo
kind: ci
---
serve's webhook test that a notice and its record are one write is quarantined on CI for 24 hours (F37, owner tl-triggers). It timed out twice on 11-05 waiting for local deliveries, on pull requests that don't touch webhooks. It still runs locally, and with AGENTRUN_RUN_QUARANTINED=1 on CI.
