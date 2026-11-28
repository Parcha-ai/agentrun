---
packages: @parcha/agentrun-serve
kind: fix
---
An agent in a workspace (the `AgentRun-Workspace` header on an API-only server) can no longer use a computer paired with the server:
- A create or definition edit in a workspace that names a paired computer is `422` at `definition.computer` (or `definition.place`), and nothing is written.
- A run of an agent in a workspace whose revision names one fails its claim with `computer_unavailable`, in the same words.
- `features.computers` in a workspace's `GET /v2/capabilities` no longer counts a kind that only a paired computer offers.
