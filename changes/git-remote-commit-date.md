---
packages: @parcha/pi-git-remote
kind: feature
---
`commitTo` and `makeCommit` take a `date`: the commit's author and committer date, to the second. Given one, the same files, parent, message and trailers make the same commit on any host at any time, so a host that writes a commit again after a crash gets the same sha. Without it the commit's dates are the clock's, as before. A date that is not a valid `Date` is refused.
