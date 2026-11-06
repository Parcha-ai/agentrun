---
packages: @parcha/agentrun-serve
kind: feature
---
A run's learning says the notes it was given (`given`: each note its `# Learned` section names, whole or as an index line) and the notes it read (`read`: the note files it opened with the read tool), and each note on the agent's learning view counts its runs of each (`runs: {given, read}`). Whether a run applied a note is not measured. Upgrading: a run's learning field `used` is now `read`, and `given` is new.
