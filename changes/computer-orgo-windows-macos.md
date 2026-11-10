---
packages: @parcha/agentrun-computer
kind: feature
---
Orgo's Windows and macOS desktops: `create({ os: "windows" | "macos", apiKey, workspaceId })` gives a desktop with daemon `none` that answers the protocol over Orgo's REST API. The screen is Orgo's screenshot; the pointer and keys are its click, drag, scroll, type and key calls; exec is its bash call (PowerShell on Windows); and on Windows the files methods go through PowerShell. The network is `open`, since Orgo has no egress control. A spec names `"windows"` or `"macos"` as its image, and `PROVIDERS` lists both as configurations of the `orgo` entry. Nothing runs in a computer Orgo does not read running. What Orgo's API cannot do (a triple click on Windows, a held key) is refused in words. A `down` and its `up` become one click or drag.
The conformance suite skips, in words, a case written for another system (`Case.os`, `caseOs`): the Linux exec and process cases, and the files cases on Windows. With `COMPUTER_ORGO_OS=windows`, `--kind desktop` runs the desktop's cases against a Windows fixture this package carries, a PowerShell script.
