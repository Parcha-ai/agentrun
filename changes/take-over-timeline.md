---
packages: @parcha/agentrun-serve, @parcha/pi-browser, @parcha/pi-durable-agent
kind: fix
---
A take-over now reads as it happened on the Timeline. "You took over the browser" and "You handed the browser back" each show the time it happened, so the gap between them is how long you held the browser. Before, each showed the time of the row above it, so an 11 s hold could read as 3 s. The agent's browser call that waited for your hand-back says so: "Waited for you 11 s, then opened www.example.com/…". Before, it read as the agent opening the page while you had the browser. Upgrading: nothing to do.
- pi-browser: a browser call that waited for the person adds `waited_for_person_ms` to its result's `details`; one stopped while it waited adds nothing.
- pi-durable-agent: a `HOST_PHASE` entry's `at` (ms) is its row's time, and a browser call's row whose result has `waited_for_person_ms` starts "Waited for you <time>, then …" when the call succeeded, and "Waited for you <time>: …" when it failed.
