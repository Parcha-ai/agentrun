---
packages: @parcha/agentrun-serve
kind: fix
---
A run's bash call in a hosted VM sandbox no longer fails with "could not close the program's input: Error: no such program" on a loaded machine. The box relay let a program go once its exit and its output were read, and the program's input close, sent separately, could land after that and get "no such program". The relay now remembers the last 4096 programs it let go after their exit. A late call for one of them is answered as already ended: an input close or write succeeds and does nothing, and an exit read gives the same exit code. A read of its output fails (410), since that output is no longer held. A program id the relay never had, or one of another run, still gets 404.
