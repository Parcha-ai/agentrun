---
packages: @parcha/agentrun-jev
kind: fix
---
Expose a JSON HTTP failure's typed `type`, `code`, and `detail.error_type` values on `JevError` as `providerType`, `providerCode`, and `providerErrorType`, without reading message text.
