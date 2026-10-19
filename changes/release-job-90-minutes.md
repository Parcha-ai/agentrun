---
packages: repo
kind: ci
---
The release workflow's publish job may run 90 minutes (it was 45). Its `npm run check` takes about 27 minutes and each package's registry wait about 3.6, with up to 20 allowed, so a release of six packages (about 53 minutes) was cancelled partway through its publishes, and the run had to be dispatched again to resume.
