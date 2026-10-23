---
packages: @parcha/pi-transport
kind: feature
---
A Modal box's `facts().gpu` is the GPU it was served, not the one asked for: the model `nvidia-smi` names in the box (a bare `H100` may be served an H200), one name for identical cards and every model, joined by ` + `, for a mixed box. A box that asked for a GPU and reports none fails the create and is ended. On attach the read runs again and the box is always handed back: a model named is the fact, none named reads `gpu: null` (the caller ends it through the handle), and when every try errs the handle keeps the model measured at create, kept in the box's tag, or the attach is an error for a box whose tag has none. The meaning of a published fact changes (it was the request): a caller that compared `facts().gpu` with its spec now compares with the model's name. Docker still repeats the request, and its documentation says it is not measured.
