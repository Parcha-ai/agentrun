---
packages: @parcha/agentrun-computer
kind: feature
---
Render Sandboxes as a computer provider (`render`, subpath `@parcha/agentrun-computer/render`): a Linux sandbox in a Render microVM, over Render's public REST API with no SDK. Settings → Computers shows a Render row that takes `RENDER_API_KEY` and `RENDER_WORKSPACE_ID`.
Its sandboxes dial the server, as Fly Machines and Cloudflare do: Render runs a command with no stdin, so once a sandbox runs, the provider starts `agentrun-dial` in it through one `runs/sync` call, and it fetches the server's daemon and dials the attach route. A server with no public https address (`AGENTRUN_PUBLIC_URL`) refuses a Render computer in words before Render is called. `prepareImage()` imports the box image once into the workspace as a sandbox build named `agentrun-box-<tag>`. Network `none`, `open` and an allow list are init's, as on the other dial providers. Render keeps no labels, so a computer's name gives its own two and the rest live in a file in the sandbox. Render has no endpoint that lengthens a running sandbox, so there is no `extend()`, and a sandbox lives at most a day. No mount: a Render computer can't mount the server's run folders.
