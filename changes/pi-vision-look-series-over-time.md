---
packages: @parcha/pi-vision
kind: fix
---
The `look` skill teaches a series of images of one scene over time: each place the question asks about is its own small box, never a region spanning several named places; a box that answers where something changed marks the change itself, as tight as that area, never the whole place or what did not change; each place's dates are read in order on its own crop, never bisected (a place that dries and refills hides its first change from a bisection) and never inferred from a whole-scene average; a place is dry or gone only when its crop shows none of it, as the eyes say and Jev confirms with a typed question for each crop and date, never from a pixel mask or threshold alone; and the place names come from the run's own files.
