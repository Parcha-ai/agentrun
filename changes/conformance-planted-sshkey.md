---
packages: @parcha/agentrun-computer
kind: fix
---
Conformance plants a real throwaway ed25519 private key for an ENV name ending `_SSH_KEY` (and hunts for its base64 body in every answer), so `health.no-key-in-errors` no longer fails at build on a provider that refuses a non-PEM key.
