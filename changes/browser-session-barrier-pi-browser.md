---
packages: @parcha/pi-browser
kind: feature
---
`createBrowserExtension` takes `beforeCreate` (type `BeforeCreate`): the host's step between a session's `creating` record (its tag, in the inventory) reaching the store and the provider's create, with the session's conversation, its tag and its commit. Nothing is created at the provider before it resolves; one that throws creates nothing, and the record ends released (`create_failed`).
