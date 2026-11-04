---
packages: @parcha/agentrun-decisions
kind: fix
---
A model other than Jev that `openrouterProvider` sends images to now knows which image is which. An object state's image fields go as top-level items after the other fields, and the first item now names them in order in `image_fields`. So `{ invoice: "<i1>", receipt: "<i2>", vendor: "Acme" }` goes as `[{ vendor: "Acme", image_fields: ["invoice", "receipt"] }, "<i1>", "<i2>"]`. Before, the field names were dropped, and a question comparing the receipt with the invoice reached the model with no word on which image was which. A state with a field of its own named `image_fields` keeps it, and the names go under `_image_fields`. Images to these models remain an OpenRouter alpha.
