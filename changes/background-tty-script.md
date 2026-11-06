---
packages: @parcha/agentrun-serve
kind: fix
---
`bash_background` with `tty: true` refuses in plain words on a box whose `script` is not util-linux's, as it already did on a box with no `script`. busybox's `script` takes no `-e`: it refuses the option, so the command never ran, and the process read as exited with busybox's usage in its log. Without `-e` it always exits 0, so the command's exit code would be lost. The refusal starts nothing and says to start the command without `tty`.
