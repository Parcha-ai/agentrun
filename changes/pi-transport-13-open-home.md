---
packages: @parcha/pi-transport
kind: feature
---
`openHome` (`./home`): one place a session runs, driven by orders (`resume`, `drain`, `seal`, `reopen`, `retire`). Its
gate holds a running session still for a move with nothing cut, or opens again and names what held it. An app is
`(ctx) => options` without `env` and `models`, so one module runs on the host and in a box.
