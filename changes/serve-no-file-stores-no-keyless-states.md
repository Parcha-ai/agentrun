---
packages: @parcha/agentrun-serve
kind: fix
---
An agent edit whose checks run while another request moves the agent's current revision is built again on the new one, or, sent with `If-Match`, answers `412`: the write is conditional on the revision it was built on, compared in the store's own transaction, so two servers on one store never both pass an `If-Match`, and an edit never carries over a place, harness or learning switch from a revision it does not follow.
