---
packages: repo
kind: fix
---
The changelog fold puts a breaking change under a **Breaking:** heading. A section that has none gets it at its top, with the rest under **Changes:**; a section a release pull request wrote keeps its one heading and gets the bullet at the end of that block. This holds for the root and package changelogs and for the release workflow's fold at the tag, so the release page shows a breaking change apart from the other changes. Before, the fold wrote it as a plain bullet among the others.
