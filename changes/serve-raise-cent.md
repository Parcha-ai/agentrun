---
packages: @parcha/agentrun-serve
kind: fix
---
A spend cap refusal names a raise that runs what it refused. The cent it rounds up to is read within the same float tail the cap's fit check allows, so a total a hair past a whole cent names the cent above it, not that cent.
