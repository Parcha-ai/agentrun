---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: feature
---
A desktop's or a phone's agent can keep what it sees: `computer_screenshot` takes `save_as`, a path relative to the run's folder ending `.png`, and saves the screenshot there through the run's own files, whatever disk the computer has. The answer is the image as before, plus `saved as <path> in the run's files` (and `saved` in its structured value). A path outside the folder, an absolute one or one not ending `.png` is refused in words before the computer is asked.
A desktop or a phone the run's folder is not mounted in (one with `exec: false`, or a provider that mounts none) tells its model once in the run, as the server's note, that the computer's own disk is not the run's files and is deleted at the end, and that `save_as` and the file tools keep what the user should get. The note goes after a due cap wrap-up, never ahead of it, and a resumed claim does not tell it again. Through a gateway, the first request of a pi desktop run on Sonnet is bounded at 10,072 tokens ($0.053, from $0.052); the documented minimums do not change.
