---
packages: @parcha/agentrun-serve
kind: fix
---
A run's live timeline page never says `working` before the row of the message it works on: the page reads the run's status first and its rows after, so its rows hold every entry its status was read from. Before, both were read at once, and a message committed between the two reads gave a page that said working with no message row yet (#2307). Upgrading: nothing to do.
