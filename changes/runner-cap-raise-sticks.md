---
packages: @parcha/agentrun-serve
kind: fix
---
A raised spend cap now holds for the rest of a run: a pi or CLI run paused at its cap and raised has its next model request admitted under the raised cap, on the runner that takes the raise and on any that takes the run over later, and a later pause names the raised cap. Before, the runner kept checking every request against the cap the run started with, so a raised run went on once and paused again at the old cap. A working run's raise holds from its next step (the step under way keeps the cap it was admitted at), and the raise's `note` says so. The run's `cost.cap_usd` and its budget card show the raised cap. A raise of a run a person stopped is refused in words (`not_continuable`: "This run was stopped: send it a message to go on, then raise its cap."), never a bare error.
