---
packages: @parcha/agentrun-computer
kind: fix
---
phone-harness, from its first live run and the second read of #2000:

- It takes the phone harness's own unlock code (`ph_` and base32 letters), which it refused, failing every connect.
- No spawned adb's argv holds the phone's endpoint or unlock code, which `/proc` shows to every user of the host. The endpoint goes to the local adb server over its socket protocol, and the unlock (the vendor's shell command `unlock <code>`) goes as the shell service `shell:unlock <code>` on a socket the adb server bound to the phone. Every spawned adb names the phone by its transport id. The `adb` option is now a transport, `{ run(args, { input }), server(service) }`, or the CLI's path.
- A phone made while both a create's answer and its recovery were lost is found: create puts the Idempotency-Key in the ledger before its POST, and `list()` takes the account session whose `request_key` is exactly that key.
- The conformance module's file ledger writes one at a time, across processes too (a lock file beside it), so no entry is lost.
- A ledger that fails is a result in words from every call, never a throw, and create rents no phone it cannot record.
- A connect that fails after adb reached the phone lets the transport go.
- release ends only a phone its ledger names. Another session on the account is refused `not_found` and sent no DELETE; an unnamed id that is already gone is ok.
- A create cancelled during its POST asks the service by its Idempotency-Key, not under the cancelled signal, and ends the phone the service made. It answers `aborted` and names that phone.
- Every ledger write create makes once the phone's id is known is guarded, the last one once the phone is ready included. If one fails, the phone is ended and create answers in words; no throw leaves a phone running.
- A cancelled `input.actions` batch stops at the action it is on: a `wait` ends when the signal fires, no later command runs, and the batch answers failed, kind `aborted`, at that action. Each adb command runs under the signal.
