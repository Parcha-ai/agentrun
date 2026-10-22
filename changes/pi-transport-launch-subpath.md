---
packages: @parcha/pi-transport
kind: breaking
---
The launcher has its own subpath, `@parcha/pi-transport/launch` (`./home` still exports the same names), and a launched program no longer inherits the box runtime's environment. Its environment is PATH, HOME, LANG (`C.UTF-8`), `PI_TRANSPORT_INCARNATION` (the incarnation, from 1) and the spec's `env`; a program that read a variable of the box's own lists it in the new `inheritEnv` (default `false`). Who breaks: a caller of `launch` whose program relied on a variable set on the box (`BoxSpec.env`, or the provider's runtime). What to do: name each such variable in `inheritEnv`.
- `env` refuses a key-shaped name (a `_`-separated segment KEY, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL or CREDENTIALS) by name, never its value, and PATH, HOME, LANG and every name the launcher sets: `env` rests in a file of the box and never holds a secret.
- A launch has a handle, `Launch` (`{ v: 1, name }`, JSON with no secret), on its state as `state.launch`; `launchState(box, launch, ctx)` and `launchStop(box, launch, options, ctx)` take it, beside `launchStatus` and `stopLaunch` by name. The state also reports `incarnation` and `restarts`.
- `Box.launcher` (optional, new on the `Box` interface): a box that keeps a program alive natively (a test's fake box) answers the three calls itself; they read it on every call. A provider leaves it undefined.
- New `LaunchErrorCode`s: `unsupported` (a spec the box cannot honour) and `refused` (a box setting that would expose what a launch holds).
