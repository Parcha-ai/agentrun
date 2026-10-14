---
packages: @parcha/pi-transport
kind: feature
---
`transport()` (`./hands`): a Harness's `env` from a parsed config. Boxes are created at first use, found again
after a restart, shared by the session or kept for each conversation, and let go with `release` or `destroy`.
`HandsDoc`, `SessionBoxesDoc` and `TransportError` are exported from the package root.
