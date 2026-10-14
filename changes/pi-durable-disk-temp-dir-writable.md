---
packages: @parcha/pi-durable-disk
kind: fix
---
**A tool may write in the temp directory it was given**
- `archilEnv`'s confinement made all of `<root>/tmp/` read-only to file operations, including the directories its own
  `createTempDir` (and `createTempFile`) hands out, so a tool that writes into the temp dir it asked for was refused
  `outside_work`: pi-vision's `read` of any media file failed on a disk run. A directory `createTempDir` returns is now
  writable, for the run's environments; the rest of `tmp/` (another run's directories, `tmp/` itself) stays read-only.
- The tool may remove that directory (`env.remove`, as vision does when it is done), and its grant goes with it.
- It is made through a held handle of `tmp/` that does not follow a link, and granted by name under the canonical `tmp/`:
  a `tmp/` a command replaced with a link is refused, and a directory swapped for a link grants nothing beyond itself.
