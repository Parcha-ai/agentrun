---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
A server now takes a computer's daemon or driver that speaks protocol 0.2 or any later 0.x, not only 0.2 exactly: a minor step from 0.2 on only adds, and the hello's groups and features say what each side has, so a 0.3 driver pairs with and attaches to a 0.2 server. A 0.1 driver is still refused, because 0.2 replaced its `apps.ui_tree` with `ui`: pairing it says "update the driver on <computer>, then pair with the same code", and attaching it says "update the driver on <computer> (the download is on the console's Computers page)", so update the driver on that computer. Another major, or a version of another shape, is refused as before; a pairing refusal for a driver newer than the server now says the server is older. A hosted daemon's drifted protocol now reads "hello: the daemon speaks protocol 1.0, and this provider 0.2".
