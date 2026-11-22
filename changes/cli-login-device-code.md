---
packages: @parcha/agentrun
kind: feature
---
`agentrun login --to URL` signs in to a remote AgentRun with a device code when its `GET /v2/capabilities` offers one (`sign_in.device`): it prints the address to open and the code to enter, waits while the sign-in is approved there, and keeps the token in the config file where a token pasted on stdin goes, so every later command sends it to that server. `--to cloud` names AgentRun cloud (`AGENTRUN_CLOUD_URL` names another).
- A server that offers no device sign-in, an open-source one among them, is signed in to as before: the token from stdin, checked against the agents list.
- Every address the sign-in fetches is on the server's own origin, over https unless the server is on this machine; no redirect is followed, and an answer of the wrong shape or size is refused with nothing written.
- The poll honors the server's interval, `slow_down` (5 s more), `authorization_pending`, `expired_token`, `access_denied` and the code's expiry. The token and the device code are never printed and never in argv.
