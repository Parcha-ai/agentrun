---
packages: repo, @parcha/agentrun-computer
kind: breaking
---
Computerd's desktop `screen.watch` has one path, the X server's DAMAGE extension: on an X server without DAMAGE it is refused, `unsupported`, with "this X server has no DAMAGE extension" (it no longer reads the whole screen every 200 ms), and hello lists no `screen.ahead`, so an `after` one past the newest frame is `invalid` and `watchScreen` keeps one ask in flight. E2B, Agent37 and Orgo desktops, and Xvfb, have DAMAGE.
