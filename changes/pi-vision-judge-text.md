---
packages: @parcha/pi-vision
kind: feature
---
`vision.judge` takes a text judgment: a request with no image, its text in `state`, and `choice`, `noul` or `score` questions. It is for judgments an agent's own words can be put to, such as whether a set of looks' answers states every name, time and number in a claim. A request with no image and a `box` question, an `image` index, no `state`, or an example is still refused before anything is sent. A text judgment sends Jev only the state and the questions, is filed and told like any look (as a look of `text`, with no blocks shown), and its key follows the state, so the same text asked again is read back and other text is asked again.
