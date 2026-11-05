---
packages: repo
kind: fix
---
A run paused at its spend cap now shows its two cap figures apart and labelled, both on the pause banner's raise and in the run header's: "Least to continue" (the served `pending.least_cap_usd`, the "at least" figure the server's words name) and "Suggested" (the served `pending.suggested_cap_usd`, which the input is prefilled with). Shown side by side without labels, the server's "at least $0.62" and a prefilled $4 read as a contradiction. A server that serves no `least_cap_usd` gets the Suggested line only.
