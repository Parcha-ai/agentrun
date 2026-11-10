---
packages: repo
kind: fix
---
Console: a setup code the server refuses (a link from an older log line whose code has since been replaced, or a mistyped code) now says what to do: "That setup code was refused: open the newest setup link in the server's log, or paste the server's token (AGENTRUN_TOKEN) here." A setup link's code is read as the base64url code the server printed, so a character a chat app took into the link after it (a "." or ")", an invisible space) is no part of it; a typed code or token is only trimmed. The Setup code field is marked as a one-time code (`autocomplete="one-time-code"`).
