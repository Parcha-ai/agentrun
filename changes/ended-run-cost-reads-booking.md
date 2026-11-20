---
packages: @parcha/agentrun-serve
kind: feature
---
An ended run whose end could not read its booking now reads its booked cost on `GET /v2/runs/{id}`, and the store keeps it; with no booking to read, `Cost.unknown` is `booking_unread` (costunknown/1).
