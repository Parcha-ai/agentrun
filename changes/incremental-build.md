---
packages: repo
kind: ci
---
`npm run build` is incremental: each package compiles once, after the packages it uses, and again only when its sources, its tsconfig or a package it uses changed. With nothing changed it takes about 2 s instead of about 100 s, a one-line change in the server about 8 s, and a build from scratch about 90 s instead of about 160 s, since no package compiles twice. `npm run typecheck` builds the same way and then checks the tests, type tests and examples, so it no longer compiles the packages a second time: about 55 s after a build from scratch instead of about 135 s, and about 2 s after a small change. A deleted or renamed source no longer leaves its module in `dist`, a deleted `dist` is built again, and a new `npm install` compiles everything again. A tsconfig that reads another package's build without a project reference to it fails the build and names the reference to add, since without it a change there would not rebuild it.
