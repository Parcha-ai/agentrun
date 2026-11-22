---
packages: @parcha/agentrun-jev
kind: fix
---
Expose a JSON HTTP failure's typed `type`, `code`, and `detail.error_type` values on `JevError` as `providerType`, `providerCode`, and `providerErrorType`. A broker-wrapped vendor object is read for those fields only; message text is never exposed.
