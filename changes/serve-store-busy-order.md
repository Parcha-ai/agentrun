---
packages: @parcha/agentrun-serve
kind: ci
---
The store-busy test for a create that waits on a held agent store now proves its point by order, not by a clock. It used to say GET /capabilities answered within 200 ms while the create waited, and a slow shared runner took 222 ms once. Now the test holds the store, waits until the server's create has met the busy store, and asks for the capabilities. The capabilities must answer 200 while the create still has no answer. Then the test lets the store go, and the create answers 201. A server whose capabilities waited on the store fails it: the create answers first. A create that answers before it reaches the store fails it at once, naming the answer, rather than leave the test waiting.
