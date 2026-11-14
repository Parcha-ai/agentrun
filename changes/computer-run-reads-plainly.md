---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
A run on a desktop or a phone reads plainly to the person watching it.
- The timeline says what the agent did on the computer: "Pressed “Display”", "Typed “dark”", "Went back", "Looked at Display in Settings", "Took a screenshot", a script's title. These replace "Using tool: computer_act". A finished act says only the steps that ran; a refused step reads "Could not press “Save”", and the act reads failed with the step and the reason. Typed or set text shows whole or not at all, and only for a step that names its field when that field is not a secure field; a type with no field of its own reads "Typed text".
- An act's answer names each step's element as the outline does (`2. press @e31 generic "Display": semantic, verified`), `[secure]` by the element's own flag. An element with no name of its own, such as an Android settings row, takes the name of the first named element inside it. A type with no element names none.
- While a new computer boots, the timeline says so ("Starting a phone from Phone harness…") instead of staying blank until "The phone is ready".
- The console's Screen tab sizes a phone to the page's visible height, so the whole phone shows without scrolling. The live view says a hand-back once, in words that name the phone.
