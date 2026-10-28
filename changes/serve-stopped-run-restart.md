---
packages: @parcha/agentrun-serve
kind: fix
---
A stopped run stays `input_required` and `idle` across a server restart. It used to read `working` and `idle`, and when its process was gone the next server opened it again as if it still had work to do. The server now keeps the stop in the run's `serve.json`, as the count of messages the person had sent when it was stopped, so the next message ends the stop with nothing to delete.
A server that stopped between saving a stop and its abort reaching the run left the turn working while the run read stopped; the next server now finishes that stop, aborting the adopted turn once.
