---
packages: @parcha/agentrun-serve, @parcha/pi-browser
kind: fix
---
A run whose files live on the run's Archil disk (Mode 2) can read what its browser saved. browser_read and screenshot file their evidence in the run's own folder on the disk, where the run's `read` opens it; before, they wrote to a local folder that a Mode 2 run never has, so the call failed. browser_upload chooses from the same folder, and refuses a path that would leave it. browser_downloads, which copies into a folder of the runner's machine, is offered only where the run's files are on that machine (Mode 1), so a Mode 2 run is never told a file was saved where it cannot open it.
pi-browser exports `uploadMime(name)`, the media type browser_upload gives a file by its name.
