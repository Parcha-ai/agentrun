---
packages: @parcha/agentrun-computer-bench, @parcha/agentrun-serve
kind: feature
---
computer-bench has a Linux desktop suite, `suites/linux-desktop`: ten tasks (five dev, five held out) in Mousepad, xfce4-terminal, Thunar and Firefox, two of them across two apps. Every task denies the agent `exec`; checks read the files, git config and server logs the work leaves, and every oracle is keyboard input only. All ten are verified live on E2B Desktop for seeds 1, 2 and 3 (untouched fails, solved passes). Setup places the windows with xdotool, puts the pointer on the one that takes the keys and activates it, so the tasks run with a window manager or without one.
- serve's `--faux` desktop answers `ping`. computer-bench pings the computer after the agent's turn, so every bench run on a faux desktop was scored infra.
