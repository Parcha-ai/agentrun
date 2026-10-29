---
packages: @parcha/pi-browser
kind: fix
---
The files real-Chrome test's teardown now waits Chrome out before it removes the profile, so the test no longer fails `ENOTEMPTY` on the profile's `Default` directory and no longer leaves an orphaned Chrome holding the run until its timeout. One teardown hook, registered first, releases the session (bounded), kills and waits on any process still naming the profile root, removes the directories after, and closes the fixture site in its `finally` so a server a skipped hook left listening cannot keep the process alive; a process that outlived the wait is reported, and a removal or site-close failure never replaces an error already in flight.
