---
packages: repo
kind: fix
---
A template's Apply screen offers a parameter whose pattern is a plain list of words (`^(crm|slack|none)$`) as a choice of those values, not a box to type one into. No parameter's help shows its raw pattern any more: it says the parameter's own description, and the server still checks the value and refuses it in its own words.
