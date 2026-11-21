---
packages: repo
kind: fix
---
`npm run build` works on Windows. The repository's scripts no longer spawn `npm` by name, which Node on Windows refuses for `npm.cmd` without a shell and can't find as plain `npm`. They run npm's own CLI script with the current Node instead: the npm that ran the script, else the one installed with that Node (`scripts/npm-command.mjs`). This also drops `npm ci`'s DEP0190 warning on Windows.
