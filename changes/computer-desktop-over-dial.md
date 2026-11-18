---
packages: @parcha/agentrun-computer
kind: feature
---
A dial host's machine can be a desktop: create adds `DISPLAY` to the boot env, the box image's `agentrun-dial` gives it to init, and the X server and window manager start through computerd's `process.start` over the socket the machine dialed. A machine token minted for a desktop takes a `linux` hello until its display answers, and a dial `connect` asks `hello` afresh. E2B is a desktop by default on `connect: "dial"` too, as on exec (`kind: "linux"` still makes a sandbox); Fly Machines, Cloudflare, Modal and Daytona stay kind `linux`. The box recipe changed, so the box image's name moved with its hash.
