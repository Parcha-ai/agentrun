---
packages: @parcha/agentrun-serve
kind: fix
---
The console's trigger forms (a schedule, a webhook, a GitHub trigger, an app trigger and a feed trigger) now take the picked agent's typed input as the run bar does. An agent whose input_schema has fields shows them under the message and sends them in `target.input` beside `content`, and the server's refusal of one of them is said at that field. An agent whose schema the fields can't show takes its whole input as JSON. Editing a schedule keeps its typed input and anything else in it the form doesn't show, and a schedule whose input has no message can be edited again. A trigger's page lists its typed input beside the message. In every trigger form's Agent picker, agents that share a name each show their id beside it.
