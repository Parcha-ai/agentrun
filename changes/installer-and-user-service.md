---
packages: @parcha/agentrun
kind: feature
---
`curl -fsSL https://agentrun.ai/install | sh` installs AgentRun on macOS or Linux (x64, arm64) with no Node.js needed: it downloads the Node.js the launcher's `engines` floor names from nodejs.org, checks it against that release's `SHASUMS256.txt`, and installs it and the launcher under `~/.agentrun` (`node/`, `lib/`, `bin/agentrun`), leaving any other Node, nvm or Homebrew alone. It adds one `PATH` line to your shell's startup file when none is there, and starts AgentRun as a service of your user, which keeps running after the terminal closes and starts again at login. Where there is no service manager, as in a container, it starts AgentRun in the terminal. `--no-start`, `--version V` and `--service` change that; running it again upgrades.
- `agentrun service install|status|start|stop|restart|logs|upgrade|uninstall` runs AgentRun as a launchd LaunchAgent on macOS or a systemd user unit on Linux, with `--no-open` and the launcher's data directory and port rules, logging to `~/.agentrun/logs/agentrun.log`. `status` prints the console's address and health. On Linux it prints the one `sudo loginctl enable-linger` line when lingering is off, and never runs sudo itself.
- `agentrun --version` prints the launcher's version.
