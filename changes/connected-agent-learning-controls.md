---
packages: repo, @parcha/agentrun-serve
kind: fix
---

Give connected coding sessions the same card layout and coding-agent Run/Edit handoffs as other
agents, with learning status and setup or settings actions. Project learning connections remain
available in Learning Dojo but no longer appear as duplicate agents in the active inventory.

The connector can associate a session with an existing project/runtime learning connection using
its installed hook receipt and a scoped proof. Learning is shown as on only after that exact session
has reported a hook window and the server and project settings allow learning. Missing setup,
unverified activation and unsupported delegated sessions remain explicit. Revoked or invalid proofs
do not grant access or prevent ordinary activity and token reports. This does not install hooks,
enroll additional projects, import conversations or change how coding sessions are started.
