---
packages: @parcha/agentrun-serve
kind: fix
---
A run's end-of-run answer that gives the same skill twice, first in a three-backtick block and then in the four-backtick block the format asks for, is read as that skill once instead of being refused whole. A note or a skill repeated word for word is read once. Two different notes or skills under one name are still refused. Upgrading: nothing to do.
