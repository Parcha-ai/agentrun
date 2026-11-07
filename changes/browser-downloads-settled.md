---
packages: @parcha/pi-browser
kind: fix
---
`browser_downloads` no longer files a download Chrome is still writing. At the end of a download (sandboxed, on a busy machine), Chrome creates the file's name empty for a moment while the bytes are still in its `.crdownload`; the local Chrome provider listed that empty file as finished, so a call in that moment copied an empty file into the workspace with the empty file's SHA-256. Now such a file, and the `.crdownload` itself, are listed as still downloading and skipped with "still downloading; call browser_downloads again", and the next call files them; a read that finds the file replaced or changed by the time it ends is skipped the same way.
