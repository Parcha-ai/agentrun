---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: feature
---
An agent can open an app on a Linux desktop. Before, every app an agent started there closed right away, so a person watching the Screen tab on E2B or Agent37 saw a black desktop for the whole run. `computer.shell.run` passes no `DISPLAY`, and its command's guard ends everything the command started, `setsid` and `&` included. Two changes fix this:
- `computer.processes.start(command, { cwd, env })` (on a computer with the processes group) starts a program that keeps running after the call. That program, and any app a launcher forks, runs until it exits or the computer ends. It answers `{ pid }`. In a run it is held to bash's setting, as `bash_background` is, so a read-only bash policy refuses it.
- On a desktop whose hello names a display, the surface adds `DISPLAY` to the env of `shell.run` and `processes.start`, under the call's own variables. An app opens where the screen is, and a tool such as `xdotool` finds it.
- The desktop-computer skill's Linux section says how to open an app.
