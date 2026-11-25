---
packages: @parcha/agentrun-serve
kind: fix
---
No run on a `--faux` start is handed a model key any more. Before, an agent's process got its revision's model's key, a workflow run got the key of its host model (`AGENT_MODEL`, or the default a saved key gives), and any run could get a model gateway's key, whether the gateway was set where the server starts or saved in the console. The faux model sends no key, so these were real keys the run never used; a run now holds only the keys its tools run on. Such a run is not handed the Claude login's token either, and neither is a run held because its model can't run. Where each run runs as a user of its own and the Claude login is this machine's own (`~/.claude`), these runs are no longer refused at their start for a login they never use. Where runs run as the runner's own user (`AGENTRUN_RUN_USER=same`), such a run now runs as a process of its own instead of inside the runner on the login.
