---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: fix
---
A scheduled run handed its previous result's `x-carried` fields is told how many entries each carried array lost from its front, "the first N entries" (the template keeps the array oldest first), no longer "the N oldest": the engine drops from the front and reads no dates. A stored `x-carried` the save would refuse (a repeated, unknown or empty name) is read as none, so its run gets the too-large line. `submitParameters` leaves every `x-` keyword out of submit tool schemas, as it does `criteria`, not only `x-carried`; a property or definition so named keeps its name.
