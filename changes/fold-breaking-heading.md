---
packages: repo
kind: fix
---
The changelog fold puts a breaking change under a **Breaking:** heading. A section that has none gets it at its top, with the rest under **Changes:**; a section a release pull request wrote keeps its one heading and gets the bullet at the end of that block. This holds for the root and package changelogs and for the release workflow's fold at the tag, so the release page shows a breaking change apart from the other changes. Before, the fold wrote it as a plain bullet among the others.

The fold also knows which fragments a section holds by a marker, not by the bullet's words. Each bullet it writes ends its first line with `<!-- changes/<slug>.md -->`, the fragment's file name. A release's section that carries a fragment's marker gets nothing more for it, so a release pull request can rewrite a late fragment's bullet in its own words and keep the marker, and the next release's fold no longer adds the raw bullet back beside it. A section that has the bullet's words and no marker now gets the bullet again. GitHub and the website hide the marker, and the release notes and the Slack post take it out.
