---
packages: @parcha/agentrun-serve
kind: fix
---
The API playground's operation field no longer closes its open list when the page finishes reading the agents. With Start a run picked, the field was drawn in one row while the agents were read and replaced by another once they arrived, so a list opened in that moment closed under the person using it.
