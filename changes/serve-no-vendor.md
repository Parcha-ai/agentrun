---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
The server reads what each computer provider takes from its descriptor and names no provider itself: a provider's saved keys fill the options its descriptor names, a setting it declares (Modal's app, `modalApp`) fills its option from the server's settings or its default, the store's session ledger goes to a provider that declares one, and the image and host options go to a provider that declares `prepareImage` or `local`. A provider added to the computer package needs no server edit. A provider the key table does not list is no longer refused when its keys are read; whether it can be made is its maker's to say. The words for a vendor's own failure are the one `vendor` code's ("<provider> answered with an error"); the old per-vendor codes read as a failed test.
`ComputerProvider` gains an optional `prepareImage(context)`: the image a computer starts from, built or pulled, for a provider whose descriptor declares `prepareImage`. Docker's is its `image()`.
