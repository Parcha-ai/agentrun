---
packages: @parcha/agentrun-serve
kind: feature
---
A computer step reads in one voice wherever a person sees it: a computer tool call's Timeline row, the step's computer call list in the console, and a Mac movie's caption all come from `@timeline/computer`'s `callWords`, in the plain past tense ("Opened TextEdit", "Selected all (⌘A), typed into the text box “Pears”", "Pressed “Save”", "Could not press “Save”"), the same on a phone, a Linux desktop and a Mac.
- An app is named as a person knows it: "org.xfce.mousepad" is Mousepad.
- The console's call list shows a failed call's code beside its words.
- Breaking: `computer_act` and `computer_observe` rows no longer show a typed or set text, a click's point or a scroll's direction, and `computer_observe` no longer names the window ("Looked at Settings", not "Looked at Display in Settings"): a row says what the call's record says. `callWords` and `stepWords` answer the past tense ("Opened TextEdit", was "open TextEdit"), and a failed call no longer carries its code in its words.
