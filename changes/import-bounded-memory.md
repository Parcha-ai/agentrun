---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome` and `agentrun-import` no longer run out of memory on a large history at node's default heap. A home's import kept every request a reader returned as a full object, and every record key it had seen as a string in a `Map`, until the run ended; a large history needed a raised heap and peaked at 4.16 GiB. Each read's sessions are now packed into the counts the totals need (request model and tokens in typed arrays), and the index that finds a record copied into a later file holds packed keys in typed arrays, with no `Map` size cap. The same history imports at the default heap, peaking at 2.4 GiB, 3.6 times faster, with the same answers.
