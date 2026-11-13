---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A pi run's cost counts every request it made. A learned workflow's model node, or a request on another model than the run's, is booked beside pi's own answers as a side call, and the run's view, its Timeline usage row and its stored cost now add it, where they read pi's answers alone (three requests booked at $0.000014 each read $0.000028). A request a lost runner left unanswered is booked cut once, however many of the next claim's bookings read it open: its hold and bound count once toward the cap, and its cost is unknown once, where a second booking could count it twice. A pi run's stored cost is now its booking's, as a CLI run's is: a run cancelled or stopped while its model's answer streamed reads its cost unknown (the cut request may be billed for what it streamed), never the $0 its cut answer carried.
