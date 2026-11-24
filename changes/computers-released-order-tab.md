---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A run's `computer.state` can now be `released`: the run is stopped, or parked on a question or an approval with no desktop, phone or sandbox kept for its resume. Before, such a run read `ready` though its computer was gone, so Settings → Computers' Running now listed it. `GET /v2/computers/running` leaves released runs out. A client that switches on `computer.state` should treat `released` as a computer the run no longer has; its next turn starts a new one.
- A run's recordings list its computers in the order they started recording, not by computer id. The recorder now writes each file's start into its MP4 header (mvhd's creation time), and the order holds while a computer records on.
- On a run's Screen tab, Tab leaves the live viewer while the agent drives, and the viewer takes the focus on load only for a person who holds the computer.
