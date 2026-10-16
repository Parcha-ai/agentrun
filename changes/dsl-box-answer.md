---
packages: @parcha/agentrun-dsl
kind: feature
---
`SystemOneQuestion` and `SystemOneAnswer` carry the Box question (`{ type: "box", instructions }` answered by `{ type: "box", box: { top, bottom, left, right }, confidence }`, the edges fractions of the image's height and width), new type `SystemOneBox`, and a response reason `box_coordinates`. `validateAnswers` refuses edges outside [0, 1] or a confidence outside [0, 1] (a missing one is `null`); `answerConfidence` reads a `null` confidence as none; `synthesizeAnswers` and `answersToValue` handle it. A Box is a host-side question: no workflow node declares one and the validator is unchanged.
