---
packages: @parcha/agentrun-serve
kind: fix
---
A run created with `hold: true` whose model can't run here now takes no end-of-run learning step either, on pi and on the CLI harnesses: its claim builds none, even when its agent learns, and a runner that starts each run in a process of its own refuses one if that process asks. No saved key is read, no draft is compiled and no audit starts for a run whose model runs nowhere.
