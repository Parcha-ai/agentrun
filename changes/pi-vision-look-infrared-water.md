---
packages: @parcha/pi-vision
kind: fix
---
The `look` skill's section on a series of images of one scene over time decides water from a near-infrared or colour-infrared picture of the same scene and date when one is given, not from the true-colour picture: open water is near black in near-infrared, while wet mud and plants, which can pass for water in true colour, are bright. The place is still shown on the true-colour picture.
- `examples/lake-mead` gives the run a colour-infrared picture for each of its thirteen dates beside the true-colour one (`lake-mead-<date>-infrared.jpg`, from the same Landsat scene and frame: near-infrared as red, red as green, green as blue, one stretch for all thirteen), so its inputs are 28.
