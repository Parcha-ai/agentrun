---
packages: repo
kind: ci
---
serve's box-image test that the default image is built on first use, once, is quarantined on CI for 24 hours (F35, owner tl-places). It failed with "Unexpected end of JSON input" on pull requests that don't touch box images, on 11-05. It still runs locally, and with AGENTRUN_RUN_QUARANTINED=1 on CI.
