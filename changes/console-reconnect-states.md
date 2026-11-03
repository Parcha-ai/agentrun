---
packages: repo
kind: feature
---
The console waits out a server that goes away (a restart, a laptop waking up) instead of showing the password page or "TypeError: Failed to fetch". Reads wait and carry on once the server answers, so a page keeps what it shows and a run's timeline picks up where it was. One banner says it is reconnecting, with the next try and Retry now, then "Resumed". Errors say what failed, why and what to do next, a missing run or agent links to its list, and pages show their shape while loading.
