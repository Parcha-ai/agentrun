---
packages: @parcha/agentrun-serve
kind: ci
---
An attached Workspace's test of a write's call order no longer depends on the umask of whoever runs it: it sets its files' modes itself, and checks both a file that gets the write setting its mode and a private one that needs none.
