---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: fix
---
A capped workflow run on the runner keeps three money rules it used to keep. A raise too small for the step that parked the run shows the new pause at the raised cap, not the launch cap, so the next raise is checked against the cap the run has. A decision whose OpenRouter catalog price can't be read for a moment is read again (three reads) before its node fails, and a catalog still down fails the node unsent, never as the cap's stop. A decision's hold is taken only after the workflow's driver has admitted its request, so a runner that dies in between no longer leaves a hold the next claim counts beside asking the decision again (a $0.40 decision was counted $0.80). In the DSL, a decision request that never left (an `unsent` refusal) now ends failed even when the run is stopping, so the next process asks it again instead of escalating it as asked and never answered.
