---
packages: repo
kind: docs
---
`examples/moves`: one agent session whose run lives on an Archil disk moves from this machine to a Modal VM with the disk mounted, where it forks 8 threads that each run a GPU job in their own H100 sandbox, and moves back; it runs offline with a scripted model and stand-in sandboxes, and live with your own Modal Secrets.
