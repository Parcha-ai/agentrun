---
packages: repo
kind: fix
---
The console says a server's deny is absolute. In Settings → Tools a tool set to deny reads "Refused on this server for every agent, whatever the agent's own setting or Never ask.", and the page no longer says an agent's own permission keeps it over this server's. In the agent editor a tool the server denies keeps its permission at deny with the same line, and can't be ticked in the Tools step; the console reads it from the agent's tools (permission deny from the server) and the server's table.
