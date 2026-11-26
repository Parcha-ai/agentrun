---
packages: @parcha/agentrun-serve
kind: fix
---
The desktop skill now says where the run's folder is. Where it is mounted on the desktop, it is `/workspace`. The desktop's terminal opens in the desktop user's home, not there, so a file saved from the terminal or an app goes in `/workspace` to reach the run. Before, the skill never named the folder, and what an agent or a person saved from the desktop's terminal stayed on the desktop.
