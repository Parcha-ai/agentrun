---
packages: repo
kind: ci
---
`node scripts/changes.mjs --check` refuses a fragment that a release already folded: one whose marker, or whose exact bullet, a released section of a changelog holds. A merge of main whose merge base predates the squash that deleted such a fragment can bring it back, and the next fold would write its bullet twice. The refusal names the changelog and the release, and says to delete the fragment with `git rm`. A late fragment that the newest release's tag carried still passes while that release's section carries its marker.
