---
packages: @parcha/agentrun-serve
kind: fix
---
A stop sent to a run before its runner had chosen the run's harness loop could end the whole runner process, along with every run it held, if that loop's stop threw. The throw is now logged instead. A run whose session fails to open at a new claim fails with the reason, and the runner keeps claiming other runs; a new test covers this with a message and an approval sent before the claim.
- Upgrading: nothing to change.
