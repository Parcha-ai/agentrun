---
packages: repo
kind: fix
---
An agent's page marks a tool its runs would not get as unavailable, with the server's reason on hover: bash and the background tools on an agent with no computer that gives a shell (#2141), and a web tool whose provider can't serve here. It reads each tool's `resolved` as `GET /v2/agents/{id}` serves it, so the page and the run agree.
Upgrading: nothing to do.
