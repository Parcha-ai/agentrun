---
packages: @parcha/pi-vision
kind: docs
---
The README installs from npm with `@beta` and no longer tells a reader to build a tarball, says plainly that pi-vision is a pi-durable extension that needs a pi-durable host (a plain `pi install` loads only the skills, and the `vision.see` they call is not defined there), that it is ESM only and what it needs (Node 22.19, Photon for images, ffmpeg for video), and names pdf.js as what `unpdf` runs. Every code sample in it declares what it uses: the programs run and print what the README shows, and the host excerpts type-check, in `test/readme.test.mjs`; a code block added to the README is a failure there until the test names it. The stranger spec checks the README's install line.
