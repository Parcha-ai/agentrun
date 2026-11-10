---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run on a translated route (OpenRouter, OpenAI and every other provider that doesn't speak Anthropic's Messages) now sends the model the images in a tool's result, so browser, desktop and phone screenshots reach it. Before, only the tool's text went and the images were dropped. On OpenRouter's chat completions each image goes as an attached image right after the tool's message, because a tool message there holds only text. On OpenAI's Responses API it goes in the call's output.
