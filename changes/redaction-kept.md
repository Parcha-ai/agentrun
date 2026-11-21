---
packages: @parcha/agentrun-serve
kind: fix
---
A run's view, its list row and its timeline are redacted of the server's secrets in a fraction of the time: what redaction derives of a set of secret values (each value's base64, hex, percent-encoded, path and folded forms, and the matchers built from them) is made once per set and kept for the next text, where it was made again for every field and every number a view served. A server with many keys in its environment spent most of each run read there: with about 40 held values, `GET /v2/runs?limit=50` took 1.8 s with 100 runs and now takes 0.3 s, and Mission Control's first load went from 21 s to 2 s. What a text is cut to is unchanged.
