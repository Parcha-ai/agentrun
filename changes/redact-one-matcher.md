---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
The server's redactor finds secret shapes and held values with one matcher (`redact/match.ts`) whose work grows with a text's length alone: each shape is read from its prefix forward, and no run is read again at each place in it. What it cuts is what it cut before, with two widenings:
- A text that holds a held value only part of which a cut covers is now withheld whole. A credential parameter's value cut in place, with the rest of the same held value past a line break (`?token=<first half>` then `<second half>` on the next line), used to show the second half; the check for a held value now reads the text as it came, not the text after its cut.
- A JWT is found from the first `eyJ` of its run of a part's characters at every site that looks for one, so a token glued to a word (`id_eyJ...`, `x9eyJ...`) is found too. The credential gate of the console's build (the console the server serves) can now fail a build whose bundle holds such a glued token, where it passed before. The computer's phone words cut it too.
