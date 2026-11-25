---
packages: @parcha/agentrun-serve
kind: fix
---
The console's app-trigger form searches its events in the Event field itself. Typing filters the open list by an event's name, slug or description, so a toolkit with hundreds of events is one field rather than a filter box above a dropdown. The search is a new console primitive, `SearchPicker` (Headless UI's Combobox, styled and wired to a `Field` as `Picker` is), for any long list.
