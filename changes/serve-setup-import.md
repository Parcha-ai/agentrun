---
packages: @parcha/agentrun-serve
kind: feature
---
**The setup page offers to import this machine's sessions, with a box never ticked for you**
- A server on this machine (no public address, listening on loopback) shows a box on its setup page once it finds Claude Code, Codex or pi sessions in its user's home: "Also import my Claude Code, Codex and pi sessions from this machine", with how many projects and sessions it found. The box is never ticked for you.
- Ticked, the import runs once the password is set, as `agentrun-serve import` does, and agents arrive as it goes. Unticked, nothing is imported. A server at a public address offers no import and refuses one asked for (`422`, field `import`).
