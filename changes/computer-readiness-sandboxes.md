---
packages: @parcha/agentrun-serve
kind: fix
---
An agent whose computer is a remote sandbox (E2B, Daytona) runs once its provider's key is saved in Settings → Computers and the server keeps workspaces on Archil (Mode 2). Before, its save warned about its place and every run was refused at the start (`agent_not_runnable`), because the start check read the computer setting as one of the old boxes. The save and the run's start now give the run's own answer: the provider and the kind it serves, the mode's mount (Mode 1 runs a sandbox only on Docker, Mode 2 on a provider that mounts Archil), and the provider's keys, read as the run reads them. A refusal is on `definition.computer`, in words that say what to do, usually in Settings → Computers. A Docker sandbox where Docker does not answer is still refused at the start in the Docker box's own words, and the refusal names the box (`details.box`). An agent with only a place saved before computer settings keeps the box check.
