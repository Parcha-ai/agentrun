---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's graph redacts held keys before it cuts a text, so a cut can no longer leave part of a key: a map item's label (cut at 200 characters), a call's error (cut at 2000, now logged whole up to 64 KB), and a decision's state stored cut past 64 KB (its last characters, where a cut key would sit, are held back).
