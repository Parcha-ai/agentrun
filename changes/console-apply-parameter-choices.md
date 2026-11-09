---
packages: repo
kind: fix
---
A template's Apply screen offers a parameter with an `enum` as a choice of those values, not a box to type one into (a number's choice is sent as a number), and a parameter whose pattern is a plain list of words (`^(crm|slack|none)$`) the same way. A value outside the set is refused by the server as `not_an_option`, shown under its field in the server's words. No parameter's help shows its raw pattern any more: it says the parameter's own description.
