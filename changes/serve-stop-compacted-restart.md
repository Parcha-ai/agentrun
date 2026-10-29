---
packages: @parcha/agentrun-serve
kind: ci
---
A test pins a stop across a restart of a compacted run, end to end. The run compacts and its turn is stopped, then the server closes and the next server reads the run from the compacted snapshot. The run still reads `input_required`/idle, and a follow-up then completes it. With the stop kept as a count of the messages shown, as before, the restart read the run as not stopped.
