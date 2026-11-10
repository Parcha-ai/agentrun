---
packages: @parcha/agentrun-serve
kind: fix
---
A run no longer lets its desktop or phone go while a person holds it. When the agent finishes while you have taken over its computer, the run waits for you to hand it back before it ends, and the Timeline says so ("The agent is done. The run ends when you hand the desktop back, or after 15 minutes with no input from you"). A forgotten take-over still ends at the hold's 15-minute idle bound, and stopping the run ends it at once.
