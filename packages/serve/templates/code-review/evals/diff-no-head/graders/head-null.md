---
type: regex
target: head_sha
pattern: '^null$'
---
The diff names no head commit, so the answer's `head_sha` is null: not the index line's `9c2d1aa` padded to 40
characters, nor any other sha.
