---
packages: @parcha/pi-transport
kind: fix
---
A box the hands environment found lost answers `exec` with the provider's `BoxError` (code `gone`) as the `ExecutionError`'s `cause`; the code stays `unknown`, as pi has no `gone` code.
