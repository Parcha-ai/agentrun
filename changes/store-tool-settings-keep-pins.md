---
packages: @parcha/agentrun-serve
kind: fix
---
The server's tool settings saved to the one store keep a tool's pin, and a pin that does not read, exactly as the file's save does: a pin is a gate fence, and a save that sends the tool's key back without a pin of its own keeps a broken one refusing until a valid pin or the key left out clears it. Both saves now share one rule (keptSettings), so they cannot drift.
