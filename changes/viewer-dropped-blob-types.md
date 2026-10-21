---
packages: repo
kind: fix
---
A recording opened from a dropped folder (or the folder picker) now reads each blob as the gallery publishes it: an extension outside the recording format's allowlist (draft 50), such as an `.svg`, a page or a script, is text, and its `blob:` URL is `text/plain`. Before, a dropped `<sha>.svg` kept the browser's own `image/svg+xml`, so its `blob:` URL, which has the viewer's origin, would run a script it carried if it was opened in a tab. Every dropped blob's URL now carries the viewer's type, never the file's own, and a type that would run in a tab is opaque bytes, as before. A dropped artifact page (`.html`) is read as text, as a files build already reads it.
