---
packages: @parcha/agentrun
kind: ci
---
A test covers `npx @parcha/agentrun` whose reader closes its pipes once it has the address (`| head -n 1`). A box image line said after that goes nowhere, and the command and its server keep running until they are stopped.
