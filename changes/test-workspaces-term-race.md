---
packages: repo
kind: ci
---
Tests only: the workspace runner's Ctrl-C test no longer loses a workspace's SIGTERM line. Its fixture step installed its SIGTERM handler after announcing its pid, so a stop landing in between ended the step unlogged.
