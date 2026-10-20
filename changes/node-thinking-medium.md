---
packages: @parcha/agentrun-pi, @parcha/agentrun-dsl
kind: feature
---
A workflow node that names no `thinking` level thinks at medium (it was low), on every Pi path: the runner, `/agentrun` and the durable node runner. Thinking is never off: a level of `off` from any source runs at medium. A node that names medium or high costs the same as before. A node that names no level and ran at low now costs more per request, and so does one that ran at off.
- `createPiRunner`: a node's own `thinking`, else the runner's `thinkingLevel` option (the caller's override), else medium.
- `createPiHostRunner` and `/agentrun`: the host session's thinking level is no longer a node's default. A node that names none thinks at medium whatever level the session runs at, `off` included. Pass `thinkingLevel` to `createPiHostRunner` to choose another default.
- The durable node runner (`@parcha/agentrun-pi/durable`): a node's own `thinking`, else the level the host's `agent(node)` sets, else medium. Before, the runner left the level to the host's agent alone, so a node's own `thinking` counted only when the host applied it. A node a task owns copied its owner conversation's level, and a node no task owns ran with thinking off. A node conversation the runner created before this change keeps its level when it resumes; one an older build opened, which the runner gives its agent when it reaches the node, takes the new level.
- The author reference (`language.md`) states the default: a node that names no `thinking` thinks at medium, unless its host sets another level.
