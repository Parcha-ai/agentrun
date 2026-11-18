---
packages: @parcha/agentrun-computer
kind: feature
---
A Linux box of your own pairs as a computer: `computerd pair <server URL> [--name <name>]` reads the console's code from stdin, sends init's own `hello` to `POST /v2/computers/pair`, and keeps the token in `~/.config/agentrun/computer.token` (root's in `/etc/agentrun/`), created `0600` and renamed into place, never printed. `computerd attach` reads that file when `AGENTRUN_ATTACH_TOKEN` is unset, and refuses one that is a link, another user's, or readable by group or others; a removed computer's `401` says which file to delete. `computerd unpair` deletes it. `computerd attach` now takes a paired computer's token (`art_` and 43 base64url) as well as a minted one. A box with a display pairs as a desktop; spec/computer/attach.md "A Linux box" has the steps and two systemd units.
A paired computer's `hello` of another arch than it paired with is now closed `4400`, as another kind or os was, so a token copied to a machine of another arch stops there; a Mac's arch may still change (Rosetta).
