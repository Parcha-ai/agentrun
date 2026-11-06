---
packages: repo
kind: fix
---
The console's run timeline says "1 earlier step" when it folds one older step away, and "N earlier steps" for more. Before, it said "1 earlier steps".

The Playground's code pane, the request for your own client, sends `$AGENTRUN_API_KEY` (cURL) and `process.env.AGENTRUN_API_KEY` (JavaScript), and its footer says to set AGENTRUN_API_KEY: the variable an API client sets, as the server prints it at start. Before, it named AGENTRUN_TOKEN, the server's own.
