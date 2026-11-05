---
packages: @parcha/pi-durable-disk
kind: fix
---
A server-written message's origin marker no longer takes a request id a caller may send. It was written as the message's
id plus `:origin`, so after the server's `foo`, a caller's own `foo:origin` was refused as already used and never reached
the model. The marker's id now has a space in it, which no caller id may contain.
