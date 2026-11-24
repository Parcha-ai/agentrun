---
packages: @parcha/agentrun-serve
kind: breaking
---
After this upgrade, a Claude login on this machine that was turned on before it reads "turned on for another machine" (`other_machine`) once, and its runs ask for a key until it is turned on again. Turn it on again under Settings → Model keys. The setting now names the machine by an id the server makes once in its data folder (`machine-id`, 0600) in place of the hostname, which changed with a laptop's network; a setting saved before has no id.
