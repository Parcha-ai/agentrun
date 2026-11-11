---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A capped run that reads screenshots is no longer refused at its cap after the first one. A model request's input bound counted an image's base64 as one token per byte, and then the image's billed maximum on top. A 1280x720 screenshot (about a megabyte of base64) read as some 1.3 million input tokens, so a Sonnet step under a $1.50 cap "needed at least $4.83" when Claude bills it a few cents. Now each image counts at what its provider can bill it as, in place of its data's bytes. On Anthropic's Messages API that is its 28-pixel patches or its area at 750 pixels a token, whichever is more, read from the image's own header (PNG, JPEG, GIF or WebP) and at most 4,784 tokens. On OpenAI's APIs it is the per-image maximum, 73,800 tokens. An image whose size can't be read counts at its API's maximum, so no image is undercounted.

`InputShape.images` (the kernel host's `providerInputOverhead`) is now a list of images, each with the bytes its data takes and its size when known, and the figure can be below 0. A policy's `serverInputOverhead` may also return below 0, never past the body's bytes. Upgrading: pass `images: [{ bytes, width?, height? }]`, built with `imageInputOf`, `messagesImagesIn` or `responsesImagesIn`, in place of a count.
