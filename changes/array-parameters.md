---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A template parameter may be a list of a scalar, so a scheduled agent's scope (the companies it watches) is set once at apply and reaches each run as typed input.
- `parameters.<name>` takes `type: array` with `items`, a scalar in the `inputs` vocabulary. Apply checks each item as an input's are, and the console asks one item a line.
- A trigger's `target.input` value that is one placeholder alone (`"${parameters.companies}"`) takes the parameter's value with its type: a list stays a list, an integer an integer. One whose parameter was given no value, and has no default, is dropped, so the input schema sees the field absent. Before, every placeholder filled as text.
- In text (instructions, display name, `content`) a list fills as its items joined by `, `, an empty one as `""`. Apply checks the filled `target.input` against the agent's input schema.
- A pin value that is a list parameter's placeholder alone pins the list as a one-of.
- An eval case whose `prompt.md` body holds its own `Input:` block is refused: the server writes that block from the case's `input:`.
