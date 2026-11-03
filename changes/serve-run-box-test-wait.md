---
packages: repo
kind: ci
---
serve's run-box tests wait for a destroyed box's container file to be gone as well as for its `rm` call. The fake `docker` writes a call's arguments before it acts on it, so under load a test could see the `rm` and then read the container still there, and the create-failure test's polling of the containers could read a file an `rm` in flight was removing. Test-only: the fake and the server are unchanged.
