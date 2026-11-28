---
packages: @parcha/agentrun-serve
kind: fix
---
The code-review template's answer has `head_sha: null` for a pasted diff that names no head commit. Its findings schema required a 40-character sha, so a review of such a diff made one up: a hosted run padded the diff's 7-character `index` hash with zeros. The skill now says to take the head the message names, in full, or null, and never a sha built from the `index` line, whose hashes are blobs. A pull request's review still answers its full head sha. A reader of the answer that took `head_sha` as always a string now also gets null, and only for a pasted diff. New eval case `diff-no-head`.
