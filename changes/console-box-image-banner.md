---
packages: repo
kind: fix
---
Console: Mission Control says when the Docker box's image is still coming ("Preparing the Docker box: building the box image (…). A sandbox run waits for it before its first tool call."), in the server's words from capabilities' `places.boxes`, as a run's page already did on its timeline. While a box prepares, the console reads the capabilities again on its own, so the line goes once the box is ready.
