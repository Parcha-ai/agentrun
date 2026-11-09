---
packages: repo
kind: fix
---
A run a webhook or GitHub trigger started is titled by the trigger's input line in the console (the runs list, the run's header, Mission Control, an agent's runs, the needs-you strip and Learning), never the `<trigger-payload … untrusted>` wrapper and the request's body after it, which stay on the run's Timeline. A trigger with no input of its own reads by its source ("A webhook request", "A GitHub event").
