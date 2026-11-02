---
packages: repo
kind: fix
---
The console keeps everything the server says about a refused request: `ClientError` carries the error's `details`, and `toApiError()` passes them on. A run start refused with `409 agent_not_runnable` for a sandbox agent on a box the server does not have now shows in the playground as "The run did not start: <reason> (box: <box>)" above the whole answer, `details.box` included. The Files tab's comment now says that files list in the server's path order.
