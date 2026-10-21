---
packages: @parcha/pi-durable-disk
kind: breaking
---
The CLI's duration flags take a unit: `ms`, `s`, `m` or `h` (`500ms`, `30s`, `1.5m`, `1h`). A bare number used to mean milliseconds, so `--every 90` ran every 90 ms. It is now refused with exit 2 and a hint: `not a duration: "90": give a unit, e.g. 90s or 90ms`. Every duration flag a command is given is checked before the command acts. **Who breaks:** a script or service unit that passes a bare number to `--park-threshold`, `--park-idle`, `--drain-timeout`, `--stop-timeout`, `--control-timeout`, `--lease-expiry`, `--stonith-timeout`, `--start-grace`, `--start-backoff-max`, `--token-grace` or `--every`. **What to do:** add the unit you meant (`90ms` keeps today's behaviour).
- Flags named -ms keep bare milliseconds (`--heartbeat-ms`, `--lease-expiry-ms`, `--lease-margin-ms`): their name carries the unit, and units are still accepted.
- A bare `0` still turns off `--park-threshold` (no parking), `--start-grace` (no grace, so no backoff) and `--start-backoff-max` (no backoff). Elsewhere `0` takes a unit (`0s`) and behaves as before.
