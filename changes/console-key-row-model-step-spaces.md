---
packages: repo
kind: fix
---
Settings → Tool keys: a key that no harness reads (TypeSafe's, which only the decisions provider uses) says what it unlocks and nothing about harnesses, where it read "Unlocks decisions.jev · Harnesses" with nothing after the label. Mission Control's model step, where the server keeps no keys, has its spaces back: "in its environment, AGENT_MODEL=provider/model-id", where it read "environment,AGENT_MODEL=".
