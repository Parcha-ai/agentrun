---
packages: @parcha/agentrun-serve
kind: fix
---
A one-time schedule set to a time already passed is refused in words a person reads, on its field: "Pick a time in the future: <time> has already passed.", never "at is in the past" (#2248). The API's 422 says it so, for the console and for SDK and CLI callers alike. The console's schedule form shows it on the time field and clears it as soon as a time ahead is picked.
