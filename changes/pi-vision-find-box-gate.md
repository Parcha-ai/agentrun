---
packages: @parcha/pi-vision
kind: fix
---
The `find` skill finds a thing by Jev's noul alone (0.8 or more), and calls its box `loose` when Jev's confidence in the box is under 0.6 instead of failing the find: asked about the same frame for the same thing, Jev drew the same box each time with a confidence anywhere from 0.31 to 0.83, so a confidence bar failed a correct answer at random.
