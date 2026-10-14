---
packages: @parcha/pi-vision
kind: feature
---
`VisionOptions.scope` gets the host's conversation id as a string; the pi-durable adapter passes pi's own `ConversationId` second, which pi's documents and `harness.snapshot` take. In that adapter a `scope`, `eyes` or `limits` callback that throws gives a media `read` a `look_failed` miss that `onMiss` hears of, and a plain text file still reads; the guard still removes the images it could not check.
