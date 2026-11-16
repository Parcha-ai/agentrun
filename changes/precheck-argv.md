---
packages: @parcha/agentrun-computer
kind: fix
---
The exec pre-check's `stdout-text` no longer passes its 1 MiB line's 16 KiB piece as printf escapes on argv (about 66 KB, past Modal's 64 KiB argument cap, so Modal refused the command before it ran): it passes the piece's 10-byte unit and `sh` repeats it in the machine. Every command the pre-check starts now stays under 32 KiB of argv; the text it checks is unchanged.
