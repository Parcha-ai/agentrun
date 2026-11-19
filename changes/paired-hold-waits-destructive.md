---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
A paired Linux box's hold now lasts until every call that changes the box has ended: a create cancelled while it clears `/workspace` still answers `aborted` at once, but the box stays held until each `files.remove` and `process.signal` (KILL) it sent has answered, or its connection has closed. A release of that hold (a resumed run's release of its earlier claim's computer) answers only then, and the hold's deadline passing waits for it too. Before, the hold was let go at the cancel, so a second run could claim the box and push its folder while the first run's recursive remove was still deleting there. `agentrun-serve --help` now names every route `AGENTRUN_API_ONLY=1` serves past the run routes: the computers list, the workspace's Archil disk and an agent's delete.
