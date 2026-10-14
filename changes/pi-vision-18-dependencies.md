---
packages: @parcha/pi-vision
kind: feature
---
It depends on `unpdf`, `@hyzyla/pdfium`, `fflate` and `@xmldom/xmldom`. `@earendil-works/pi-durable` and `@earendil-works/chord` (1.0.4 to 1.2.x), `@earendil-works/pi-ai` (`*`: the host's copy, as Pi's package guidance asks of a package that imports it) and `@silvia-odwyer/photon-node` are optional peers. The package is developed on pi 1.1.0, and its suite also runs on pi 1.2.0 and on 1.0.4, each with one copy of every pi package. sharp is passed in by a host, never a dependency or a peer, so its LGPL code stays out of the package's dependency graph.
