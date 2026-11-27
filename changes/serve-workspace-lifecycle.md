---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header on an API-only server) can now archive, unarchive and delete its own agents (`POST /v2/agents/{id}/archive`, `/unarchive`, `DELETE /v2/agents/{id}`) and delete its own imported template packages (`DELETE /v2/templates/{id}`). Another workspace's agent or package answers the same `404` as an id no row has, and a bundled package stays `403`. These were `403 not_scoped` before, so a backend in front of the server could not run its tenants' agent lifecycle. The store deletes a package only while it is still the one the delete read (and, in a workspace, only while that workspace holds it), in the one write, so a delete racing another import of the same name never removes the newer package: that import stands, kept and served, and the delete that lost to it is `404`.
