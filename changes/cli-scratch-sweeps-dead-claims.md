---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code, Codex or OpenCode run whose runner was killed mid-turn no longer leaves the dead claim's files on the runner's disk. The killed claim never ran its own sweep, so its folder (`<data>/scratch/<agent>/<run>/harness/<epoch>`, the CLI's home and session state) stayed after the run ended. Now each claim of a run removes every earlier claim's folder of that run when it starts and again when it ends, and the run's scratch folder goes once its last claim ends. A later claim's folder and other runs' folders are left alone. A sweep that is itself cut off partway is finished by the run's next sweep. An agent's emptied `scratch/<agent>` folder now goes with its last run's.
