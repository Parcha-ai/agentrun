---
packages: repo, @parcha/agentrun-computer
kind: breaking
---
Computerd's desktop `screen.watch` no longer reads the whole screen every 200 ms on an X server without the DAMAGE extension: it is refused there, `unsupported`, with "this X server has no DAMAGE extension". E2B, Agent37 and Orgo desktops, and Xvfb, have DAMAGE.
