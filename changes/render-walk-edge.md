---
packages: repo
kind: ci
---
The Render walk tries a request to the service again while Render's edge answers 502, 503 or 504 (for up to a minute, as a new deploy takes its traffic), and says so in its setup row. Any answer from the server itself is taken as it is.
