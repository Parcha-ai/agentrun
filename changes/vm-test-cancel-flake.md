---
packages: @parcha/agentrun-serve
kind: ci
---
The VM box tests' fake never reuses a sandbox id or directory within a process, so a server one test left still finishing its runs' ends cannot reach the next test's sandbox. The cancel test also checks that the turn's end copied the box's file back before it cancels, which shows which copy back is missing if it fails again.
