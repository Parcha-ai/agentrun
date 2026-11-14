---
packages: @parcha/agentrun-computer-bench
kind: feature
---
computer-bench has a Linux desktop suite, `suites/linux-desktop`: ten tasks (five dev, five held out) in Mousepad, xfce4-terminal, Thunar and Firefox, two of them across two apps. Every task denies the agent `exec`; checks read the files, git config and server logs the work leaves, and every oracle is keyboard input only. All ten are verified live on E2B Desktop for seeds 1, 2 and 3 (untouched fails, solved passes). E2B Desktop can't run a window manager (its user has no passwd entry, so no session bus starts), so setup places the windows with xdotool and puts the pointer on the one that takes the keys.
