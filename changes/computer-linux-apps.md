---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
A Linux desktop has the `apps` group, as a Mac does: `computer.apps.open("mousepad")` and `computer.apps.list()` read the same on both.
- computerd answers `apps.list`, `apps.launch` and `apps.terminate` on its X display. `apps.list` reads the desktop's `.desktop` files. `apps.launch` takes an id, a name or a program, starts the app with `DISPLAY` so it runs on after the call, and answers `{}` once the app's window shows, raised and focused. It answers `timeout` ("no window within 10 s") when none does. `apps.terminate` ends the app and waits until its windows are gone.
- E2B's and Agent37's desktops start xfwm4 once the display is up (`DesktopOptions.windowManager`), so the apps an agent opens are framed and focused.
- The Agent37 box image (`agentrun-box`) adds xfwm4, Xfce's terminal, Mousepad, Firefox ESR and xdotool.
- The conformance case `apps.launch-terminate` runs on any Linux desktop that lists Mousepad or Xfce's terminal.
