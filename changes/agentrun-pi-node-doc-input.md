---
packages: @parcha/agentrun-pi
kind: feature
---
The durable node runner's configuration document, `agentrun.node`, carries the node's input. `value.input` is the node's prompt state: the JSON object its user text was stringified from. A reader can show what a node was given without parsing its prompt.
- It is optional. It is absent when a node's user text is not a JSON object, and from a document an older build wrote. A run an older build started resumes on that document as it is, and the document is not written again.
- `NodeDoc`'s value type gains `input?`. Nothing else in the document changes. The attempt's binding digest and the node index do not read the document.
- Size: on one recorded run of 20 nodes it added about 44 KB, 0.14% of the recording. Each document row grew by 0.5 to 2.2 KB.
