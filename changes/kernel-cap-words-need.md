---
packages: @parcha/agentrun-kernel
kind: ci
---
The kernel's spend cap, still unused until the cutover, says what a refused step needs its least for: its input's bound (counted at a token per byte, the most a byte-level tokenizer can make of it), how much of that the cache reads, and the least answer it keeps. A step after many fetched pages can need far more than the run spent so far, and the words now show why. Amounts under a cent are said to four places, and a need is rounded up there, never past it: a step that needs $0.0024 reads "$0.0024", not "$0.01", and a budget under a cent is never "about $0". The raise a parked run is offered scales from its need: under a dollar it goes to the cent, so a $0.0002 cap is offered $0.03, not $1.
