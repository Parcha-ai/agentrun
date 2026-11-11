---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A capped run that reads screenshots is no longer refused at its cap after the first one. A model request's input bound counted an image's base64 as one token per byte, and then the image's billed maximum on top. A 1280x720 screenshot (about a megabyte of base64) read as some 1.3 million input tokens, so a Sonnet step under a $1.50 cap "needed at least $4.83" when Claude bills it a few cents.

Each image, in every turn, now counts at what the routed model's provider can bill it as, in place of its data's bytes, whatever API carries it. The size comes from the image's own header (PNG, JPEG, GIF or WebP):
- Anthropic: its 28-pixel patches or its area at 750 pixels a token, whichever is more, at most 4,784.
- OpenAI: its 512-pixel tiles after resizing (85 + 170 each) or its 32-pixel patches at 2.46, whichever is more, at most 73,800.
- Google: 258 per 768-pixel tile, at least 1,120.
- Any other provider: the most of the three.
An image whose size can't be read counts at its provider's per-image maximum, never at its bytes. An image-shaped object outside where the API reads images (a tool call's arguments) is counted at its bytes, as text.

`InputShape.images` (the kernel host's `providerInputOverhead`) is now a list of images, each with the bytes its data takes and its size when known; `InputShape.model` names the routed model; the figure can be below 0, and so can a policy's `serverInputOverhead`, never past the body's bytes. Upgrading: pass `images: [{ bytes, width?, height? }]`, built with `imageInputOf`, `messagesImagesIn` or `responsesImagesIn`, and the model, in place of a count.
