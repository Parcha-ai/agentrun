---
packages: @parcha/agentrun-serve
kind: fix
---
A shared run's title now cuts every env command's output, not just output that opens with `NAME=value`. After a prompt in the title, the fewest words that print the environment or read a `.env` file count as the command, and everything after them up to the next prompt is cut. That covers `printenv NAME`, `echo $NAME`, `cat .env`, `docker inspect` and `heroku config`. The command's own argument is cut with the output (`$ printenv [redacted:env-dump 1 lines]`). A share host reads an uploaded title the same way, and it accepts a title the export already cut.
