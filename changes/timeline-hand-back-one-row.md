---
packages: @parcha/pi-durable-agent
kind: fix
---
A browser hand-over's answered entry that names its ask (`agent.handover` with an `id`: the person's hand-back, a cancel, an expiry) shows no row of its own. The run's process writes that action's row ("You handed the browser back", "You cancelled the agent's hand-over", "The agent's hand-over expired before you answered it"), so a hand-back shows one row, as before, and never "You signed in". A `done` entry naming its session alone is still a sign-in and still shows "You signed in".
