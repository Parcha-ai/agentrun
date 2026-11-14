---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
A template's `parameters` are read, compiled and checked as its `inputs` are: one grammar, one compiler, one required rule. Breaking: a parameter is required unless it says `required: false`, a `default` is allowed only beside `required: false`, and GET /v2/templates serves `parameters` as a closed JSON Schema object (`type`, `additionalProperties: false`, `required`, `properties`) where it served a map of descriptors. A package that left a parameter optional by omitting `required` adds `required: false`; a client that read `parameters.<name>.required` reads `parameters.required` and `parameters.properties.<name>`.
- Apply fills a blank parameter (absent, or `""`) with its default, then checks the parameters with the run input check, so a refusal reads as a run's: `parameters.topic is required`, `parameters keeps no field tone`, the validator's own words for a bound or a pattern.
- A parameter takes the `inputs` keys (`title`, `examples`, `minimum`, `maxLength`, …); `cron` and `timezone` are in the one format list. The console's Apply form is the run form: a parameter's `title` is its label.
