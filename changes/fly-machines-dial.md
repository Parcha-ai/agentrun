---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Fly Machines is a computer provider (`fly`, `@parcha/agentrun-computer/fly`): a dial host whose machines boot the box image and dial the server, with `FLY_API_TOKEN` and `FLY_APP` (the Fly app its machines live in) saved in Settings → Computers. Its Core runs inside the server the machines dial: `node packages/serve/scripts/dial-conformance.mjs --provider fly`, with `COMPUTER_FLY_API_TOKEN`, `COMPUTER_FLY_APP`, `AGENTRUN_PUBLIC_URL` and `PORT` set, which the server's image carries. It prints its report between two marker lines and then idles until stopped (`--exit` exits instead), so a host that restarts an exited process does not start a second run.
