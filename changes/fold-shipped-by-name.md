---
packages: repo
kind: ci
---
The release fold places a fragment the previous release's tag carried under that release by its file name, in the text the tag carried, also when a pull request edited or deleted it after the tag. Before, an edited fragment (a retired package dropped from its packages) folded under the new release as if it were new, and a deleted one was in no changelog. A deleted one is added only when that release's section doesn't hold it yet, so the release workflow's fold at the new tag adds nothing twice.
