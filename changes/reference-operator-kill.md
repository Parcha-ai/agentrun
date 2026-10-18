---
packages: repo
kind: feature
---
`--operator-kill <file>`: a control file the supervisor watches. When it appears while a process runs, the supervisor removes it, writes a `kill` host line (`crossing` null, label `operator`), kills through the place and resumes as usual; a kill still planned for the ended attempt moves to the next.
