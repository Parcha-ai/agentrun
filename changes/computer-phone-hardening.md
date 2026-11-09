---
packages: @parcha/agentrun-computer
kind: fix
---
phone-harness, from the third read of #2000:

- The vendor's unlock reply is redacted of every occurrence of the unlock code, not only the first.
- A connect and the last holder's release no longer race the phone's adb transport. A connect waits for a disconnect still on its way, and takes its hold before `host:connect`, so a last release meanwhile keeps the transport.
