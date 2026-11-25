---
packages: repo
kind: ci
---
The Sentry-walk tracing test reads a run's spans after the claim's trace has ended, so a slow store no longer leaves `invoke_agent` out of what it checks.
