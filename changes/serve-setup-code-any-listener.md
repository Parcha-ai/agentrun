---
packages: @parcha/agentrun-serve
kind: fix
---
Setup takes the printed code on any listener but loopback. Open setup (a first visit that sets the password with no code) held whenever no public address was set, whatever address the server listened on: the image listens on 0.0.0.0 with none, so anyone who reached the port before the operator could set the password and become the owner. Now open setup holds only on a loopback listener; bound to any other address, the server prints `Set up this server: <url>/setup#code=<code>` as it does with a public address, and setup takes that code or the token.
