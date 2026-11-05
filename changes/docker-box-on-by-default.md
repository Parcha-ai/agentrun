---
packages: @parcha/agentrun-serve
kind: feature
---
The Docker box is on by default. A server started with `AGENTRUN_BOXES` not set at all (a plain `npx @parcha/agentrun`) probes Docker at its start, as if `docker` were listed, and offers it when Docker answers, so a new agent lands in the Docker box with a shell. Where Docker does not answer, new agents run on the runner, and the banner (`Boxes: none, so new agents run on the runner. Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun.`), `capabilities.places.default_reason`, docker's `reason` and the console's new-agent form say why. With Docker on, the banner says `Boxes: docker (on by default; set AGENTRUN_BOXES to change).`
An `AGENTRUN_BOXES` you set still wins: a list probes only what it names, and an empty value or `none` sets up no box (`none` stands alone). Daytona, the VM box and bwrap stay yours to list. Docker's reasons say what is wrong in plain words first (`Docker isn't running on this machine`), then what to do.
