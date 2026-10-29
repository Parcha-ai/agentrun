---
packages: @parcha/agentrun-pi
kind: feature
---
**A decision row can name the admission its request was sent under (`DecisionRow.admission`)**
- A host that admits each typed-question request before sending it (so a request the run stopped before the answer came back is still counted) records the admission's id on the request's row. The row settles that admission in the row's own commit: a cost fold counts an admission no row names, and never one a row names, so a process stopped between the two counts the request once.
