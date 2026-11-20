---
packages: @parcha/pi-browser
kind: fix
---
A session whose create answer was lost, and which the release task found later by its tag, is now told to the host's `onSession` at its release with the id that lookup found and the bill its release records. Before, the host heard it with `resourceId` null and nothing spent, because the release is told before the commit that records them.
