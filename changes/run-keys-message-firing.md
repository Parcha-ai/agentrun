---
packages: @parcha/agentrun-serve
kind: fix
---
With `AGENTRUN_RUN_KEYS=1`, a `message_run` trigger whose run owes a tool key the server does not hold now fails each firing with 409 `agent_not_runnable` naming the key, and sends nothing. This catches a trigger made before the setting was on, or while the server held the key. In 0.1.0-beta.54 its firing opened a turn with no key, and that turn failed at the tool.
- A message refused for a key its run owes answers the same 409 as a start refused for it, `details` included (`{"unbound": [], "missing": {}}`). In 0.1.0-beta.54 the message's 409 had no `details`.
- A firing is checked as one that brings no keys, whatever the run holds then. So a `message_run` firing to a run mid-turn, still holding the keys its start or a person's message carried, is refused, while a person's message to that run passes on those keys. For a run whose template's keys the server does not hold, that is the safe side: a trigger's message never spends the keys a person handed that run. A run that owes no keys (an agent from no template, or one whose keys the server holds) is not checked, so a `message_run` firing to it mid-turn still runs on the keys its start or a person's message carried.
