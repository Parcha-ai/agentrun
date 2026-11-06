---
packages: @parcha/agentrun-serve
kind: fix
---
Every deny the model reads now says plainly that the call never left: "It was not run: nothing was sent and nothing was charged." It covers a tool set to deny, an ask refused because no one can approve, the owner's deny of a parked call, and a person's declining message. After a deny, a model no longer tells the person it can't confirm whether a charge was made.

An approved call that ran before a crash keeps its saved result when its tool is set to deny before the run reopens: the model gets that result, never "nothing was charged", and it is booked once. A call cut after it started but before its outcome is denied with no claim either way ("It had started before the deny, and whether it took effect is not known.").
