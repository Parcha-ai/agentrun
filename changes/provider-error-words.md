---
packages: @parcha/agentrun-serve
kind: fix
---
When a computer's provider or the run's Archil disk fails, the run and its tool results now say so in serve's words, never the provider's. The provider's text can carry a host path, a vendor's JSON or a key-shaped string. Each failure is sorted into one of five classes, and each class has one sentence that names the provider and what to do:
- key refused: "Docker refused its key. Check the Docker key in Settings."
- quota or billing: "E2B says the account is out of quota or credit. Check the E2B account's plan and billing, then try again."
- provider down or unreachable: "Modal couldn't be reached. Try again, or pick another place in Settings."
- machine refused or gone: "Docker refused the sandbox, or no longer has it. Try again, and a new one starts."
- anything else: "Archil answered with an error. The server log has the details."

The provider's own words go to one runner log line, `run <id> <site>: <class>: <words>`, with secrets cut from it. This covers a run that fails at its claim, a sandbox lost mid-run (the cut call, a new one's failed start, the run's end past the bound, a call outside a tool call), and an Archil disk's failures as the agent's file tools, its exec and the console's run-file routes read them. The class comes from the error's code or HTTP status first, and from its text only where neither says anything. A tool's own output, such as a shell's stderr or a file read's error about the agent's own path, passes as it is.
