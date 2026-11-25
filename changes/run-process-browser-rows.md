---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose loop runs in a process of its own (the runner's default) now reports its browser to the server: a browser its owner took over reads `computer.state: "taken_over"` (Running now's "You drive"), and a browser let go while the run waited for its person shows the Screen tab's ended state. The run's process writes both rows itself, and the store a run's process reaches refused every settings write, so neither ever reached the server outside a test. It may now write and remove those two rows of its own run, and no other.
