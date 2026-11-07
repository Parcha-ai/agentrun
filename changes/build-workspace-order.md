---
packages: repo
kind: fix
---
The root build (`npm run build`) builds the workspaces in dependency order (scripts/build-workspaces.mjs): each package once, after every workspace package it names in its dependencies, devDependencies or peerDependencies, so none compiles against a dist an earlier build left behind. A cycle, or a package's build that fails, stops it loudly. A build of some workspaces goes through the same order (`--only a,b,c`; scripts/pi-leg.mjs builds its leg's set so), and stops on a package whose workspace dependency is outside the set with no dist. The packages that built a dependency themselves when its dist was missing (harness, decisions, learn and pi-agent-learn: `test -f ../<dep>/dist/... || npm --prefix ../<dep> run build`) now compile only themselves: a dist already there, stale after a merge, was taken as current.
Upgrading: build one package alone (`npm run build -w <package>`) only after its workspace dependencies are built; `npm run build` at the root builds them all in order.
