---
packages: repo
kind: ci
---
The publish workflow's gate stops a release whose tag is not the code its release gate ran on. The release pull request records the commit the gate passed on a line of its own, `Gated cut: <40-hex sha>`, and the last such line counts. The tag's tree must be that commit's tree, or differ from it only in the release's own files: version lines moved by the release's versions, changelogs that only gain lines, and deleted `changes/` fragments. A refusal names both trees, the files, and the commits under the tag the gate never saw. The merge queue had put pull requests ahead of the release commit in beta.60, beta.63, beta.64 and beta.68. `node scripts/release-gated-cut.mjs --tag <tag> --cut <sha>` runs the same check before the tag is pushed.
