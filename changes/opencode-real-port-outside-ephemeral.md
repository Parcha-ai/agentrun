---
packages: repo
kind: ci
---
serve's test of OpenCode on one port across twenty drives no longer fails now and then on a busy CI machine. It took its port from the range the kernel hands to any listen(0) or outbound connection, so another test could be handed that port in the moment between one drive and the next, and the next OpenCode could not bind it ("OpenCode exited before it listened", ServeError). The test now takes a free port below that range, and a drive that does not complete names its error. This ejected a merge-queue run and failed a PR on 11-05 (F36); its quarantine is lifted.
