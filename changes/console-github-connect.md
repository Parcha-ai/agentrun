---
packages: repo
kind: feature
---
Settings has a GitHub page (`#/settings/github`) for this server's one GitHub App.
- **Not connected.** Connect GitHub (an organization optional) posts the App's manifest to GitHub, once. GitHub then has you create the App and install it.
- **Connected.** The page shows the App, linked to GitHub, with its id and the accounts it is installed on.
- **Disconnect.** It asks first. Every GitHub trigger turns off, and the page shows the server's note on deleting the App on GitHub, with its URL as a link.
- **Refusals.** No public URL, no seal key, or already connected show in the server's words.
- **The way back from GitHub.** It reads as "Connected", or as words per reason (state_invalid, conversion_failed, installation_unverified). The page never shows the raw value, and leaves no query on the address.
