---
packages: @parcha/agentrun-computer
kind: fix
---
A new connection to a phone no longer fails its first ui call with "another UiAutomation client holds the phone's accessibility" when the last connection closed a moment before. Each connection's phoned held the phone's one UiAutomation registration until it exited, after its connection closed, and the next phoned could start and ask for it first. The phone harness provider now keeps each phoned's pid and starts the next phoned on that phone only once the last one is gone: it waits up to 10 s on the phone, kills it then, and fails the connect in words if even a kill leaves it running.
