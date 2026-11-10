---
packages: @parcha/agentrun-serve
kind: breaking
---
Sign out signs out this browser only: `POST /v2/auth/sign-out` revokes its session on the server (each session now has an id, kept in the owner file as revoked until it would have ended, so a copy of that cookie stops working too) and clears its cookie, and leaves every other browser signed in. A session made before this change has no id: sign in once more after upgrading. The new `POST /v2/auth/sign-out-everywhere` ends every session on every browser and phone (what Sign out did before), and the console offers it as **Sign out everywhere**, below Sign out, after a confirm: "Signs out every browser and phone signed in to this server, this one too."
