---
packages: @parcha/agentrun-serve
kind: feature
---
A run whose bash has a policy (`tool_settings.bash.policy: "read-only"`) now runs each shell command on Archil's serverless exec (Mode 2, no computer) with its egress denied (`network: {egress: {default: "deny"}}`), so a command can reach the run's folder and nothing on the network. If the owner's Archil plan takes no network policy (a 403 such as `network_plan_required` on the Free plan), the command runs with the network open, and its stderr starts with one line saying so, with Archil's words in it. The workspace remembers the refusal and doesn't ask again. The read-only gate still holds either way. Only the shell's commands are denied: the server's own execs on the run's folder keep Archil's default network. A command on a local folder or in a computer can't be given a network policy, and a Workspace exec that asks for one there is refused before anything runs.
