---
packages: repo
kind: feature
---
**The chat view draws a run's answer that is a list of flat records, and a pipe table in the agent's words, as tables**
- An answer field that is a list of flat records (every value a scalar or a list of scalars) is a table: columns in the order the records first name them, a list of scalars as a comma list, a missing field as an empty cell. Its cells are plain text, never markdown. Any other answer keeps its JSON.
- A markdown pipe table in the agent's words (thinking, said text, Muse bubbles) is a table whose cells keep the page's inline markdown. The first line that is not a row ends the table and stays words, so nothing the agent wrote is dropped. A table wider than its box scrolls inside the box; the page never scrolls sideways.
