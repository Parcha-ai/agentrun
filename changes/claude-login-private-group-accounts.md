---
packages: @parcha/agentrun-serve
kind: fix
---
Claude Code's login on this machine no longer counts a group-writable folder's group as the user's private group when `/etc/group` gives that group a password (anything but `x`, `!`, `*` or empty), since anyone who knows it may join the group; the refusal names the group and the password. Nor when the account files hold a second account with the user's name or uid, or an id after blanks, which the system still reads. The serve README now says that a user removed from the group keeps it in sessions already open.
