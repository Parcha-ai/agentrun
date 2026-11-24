---
packages: @parcha/agentrun-serve
kind: fix
---
A held value split across two strings of a web_search or web_fetch answer is withheld when the redactor does not list its values and the answer passes 8,192 characters, and when the halves sit side by side only in the order the answer was written.
