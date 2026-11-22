---
packages: @parcha/agentrun-serve
kind: fix
---
A monid call charged above the estimate it was held at no longer stops a run that can still afford it. It is booked as charged and logged, and the run stops only when that charge takes it past its spend cap, in the cap's words, as a fal job's does. Before, any such charge stopped the run, failed, in the words "monid charged $X, more than the $Y held; the run stopped", even far below its cap.
