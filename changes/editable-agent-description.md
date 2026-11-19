---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's description can be edited. `PUT /v2/agents/{agent_id}/definition` with a new `definition.description` makes the next revision and changes the description in the same commit, so an edit refused by its check or by a stale `If-Match` (`412`) changes neither; an edit that leaves the description out keeps it, and the same description sent again writes nothing. It was refused `422` before, so an agent the setup import made kept its project folder's path as its description for good. The name and id stay fixed: a changed name is still `422 input_invalid` on `definition.name`. In the console, Edit agent's Description field (and the request editor's) is editable and sent with the save.
