---
packages: @parcha/pi-transport
kind: feature
---
A Modal box reports `secretsVia: "fd"`, so a launch can carry a stdin and secrets to it: the launch frame rides the stdin of the exec that starts the launcher, and no value goes in an argv, the `env` or `secrets` parameters, a tag or a fact. The provider is trusted with the box; whether it keeps an exec's stdin is undocumented, and no claim is made about it.
- Behaviour change: a `close()` of a Modal program's input that fails while the program still runs is now returned by `wait()` (an `unknown` error naming the input), where it was ignored; a close that fails on a program that already exited is still ignored.
