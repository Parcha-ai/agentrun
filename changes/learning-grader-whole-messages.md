---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
The learning grader reads what the user sent a run from the run's own store, whole: its first message and each message sent to it after, in order. It read them from the run's timeline rows, which end a message at 2,000 characters, so a rule the user took back past that point never reached it. Each message is then cut of the server's secrets, shortened to its start and its last 300 characters, and held to the same budget as before. `@parcha/pi-durable-agent/timeline` exports `originMatcher` and `isUserEntry`, which tell the person's messages from the server's. Upgrading: nothing to do.
