---
packages: @parcha/agentrun-serve
kind: fix
---
A new browser session whose reserve the spend cap refused is now asked for its reserve again at its next charge, so once the cap is raised its next stretch is held on the run's ledger. Before, the refused reserve was never asked again and the session ran on with nothing held for it, even after a raise.
