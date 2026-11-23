---
packages: @parcha/agentrun-computer
kind: fix
---
A write to a command on a Groundbox computer no longer fails with "the process has ended" when the command reads it and ends at once. The write checked for the command's fifo after writing to it. A line the command ends on (`exit`, the last line of a `while read` loop) reached the command, and the write still failed whenever the command's shell had removed the fifo first. The write now checks the fifo after opening it and before writing, and once every byte is in the fifo the write is made. A write to a command that ended before it, or while it was writing, still fails with "the process has ended". A fifo gone before the write opened it now gets none of the write's bytes; before, they went into a file the write then removed.
