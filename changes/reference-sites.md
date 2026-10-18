---
packages: repo
kind: feature
---
The reference entry takes `sites` from a demo's spec: the agent gets `use_website`, and a task for a site runs a child agent in a browser of its own and answers a short report. A kill while the child works leaves it recorded under its site and request id, and the resumed run finds it instead of starting another.
