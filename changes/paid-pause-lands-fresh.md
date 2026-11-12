---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A paid call the cap refused for room pauses the run with the run's spend as it is when the pause lands, and never refuses a person's answer to a question the same turn ended on:
- The budget card (and its words) count what calls beside the refused one charged before the model's next request, not the spend at the refusal. A call that would now fit (one beside it settled for less than it held) pauses nothing.
- A turn that ends on a question to the person (ask_person) with no next model request drops the refused call's pending pause, so the person's answer reaches the model and is never refused in that call's words, on this claim or the next.
- The kernel cap's refusal for a paid call names the call (`figures.step`: its name, hold and basis), and `paidRefusal` is exported, so a host can say a refusal again with the run's spend later.
