---
packages: repo
kind: feature
---
A template's Apply screen shows each webhook trigger it made. When the apply's first answer to your session carries its signing secret, the screen shows it once, beside the trigger's URL, with Copy and "You won't see this secret again."; it lives in that screen alone. Without the value (a replay of the same apply, or a token's), it shows the server's note and a link to the trigger ("Open <trigger> to get its signing secret (Rotate)"). Schedule and GitHub triggers have no secret and get neither.
