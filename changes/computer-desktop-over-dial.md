---
packages: @parcha/agentrun-computer
kind: feature
---
A dial host's machine can be a desktop: create adds `DISPLAY` to the boot env, the box image's `agentrun-dial` gives it to init, and the X server and window manager start through computerd's `process.start` over the socket the machine dialed. A machine token minted for a desktop takes a `linux` hello on its own os and arch until its display answers; until a hello says `desktop`, `connect` gives a linux computer whose screen, input, apps, ui and watch calls are refused in words, never sent. Every dial provider takes `kind: "desktop"` from the box image, and each descriptor declares a desktop configuration: E2B (its default, as on exec), Fly Machines, Cloudflare (standard-3), and Modal and Daytona on `connect: "dial"` alone (their constructors refuse a desktop on exec). The box recipe changed, so the box image's name moved with its hash.
