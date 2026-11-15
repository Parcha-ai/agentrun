---
packages: @parcha/agentrun-serve
kind: feature
---
A template package's trigger can be on or off by a parameter: `enabled: "${parameters.<name>}"`, one placeholder alone naming a boolean parameter with a default. Apply fills it and makes the trigger enabled or disabled by the owner's answer (the default when it is left out), so a package can ship a second schedule the owner opts into, such as a weekly brief behind `weekly: false`. The owner can switch it later as any trigger. Validate refuses any other text in `enabled`, a parameter that is not a boolean, and one with no default, each in its own words.
