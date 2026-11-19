---
packages: @parcha/agentrun-computer
kind: fix
---
A paired Linux box stays held until each `files.remove` and KILL its create sent has answered or its connection has closed; before, a cancelled create let the box go while its remove still ran.
