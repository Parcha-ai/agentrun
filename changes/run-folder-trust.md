---
packages: @parcha/agentrun-serve
kind: fix
---
On the runner a run's folder is its workspace, which the agent's own file tools and the run's file list reach, and the server now neither trusts nor writes anything there for itself. The tool gate no longer reads `turn-origin.json` from the run's folder: nothing on the server wrote it any more, so a file the agent wrote there could make the gate refuse the agent's own writes under `.learning/`. The end-of-run turn's refusal of those writes is the adapter loop's own. A browser viewer's hand-over goes only through the store under the run's claim; with no store seam none is handed over, never as a file holding the viewer's token in the run's folder.
