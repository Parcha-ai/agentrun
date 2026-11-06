---
packages: @parcha/agentrun-serve
kind: fix
---
When Docker's socket refuses the server's process (its user was added to the `docker` group after the process, or the systemd user manager that started it, was already running), the `Boxes:` line and docker's reason in capabilities now say so and how to fix it without a reboot: "this server's process isn't in the docker group: restart your user manager with `sudo systemctl restart user@$(id -u)`, or log in again if linger is off". Other Docker failures keep their words.
