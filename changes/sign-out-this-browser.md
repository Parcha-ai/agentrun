---
packages: @parcha/agentrun-serve
kind: breaking
---
Sign out signs out this browser only: `POST /v2/auth/sign-out` clears its session cookie and leaves every other browser signed in. The new `POST /v2/auth/sign-out-everywhere` ends every session on every browser and phone (what Sign out did before), and the console offers it as **Sign out everywhere**, below Sign out, after a confirm: "Signs out every browser and phone signed in to this server, this one too."
