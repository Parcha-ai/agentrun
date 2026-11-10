---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/computers` now says what host tools each computer choice gives. Each provider, and the one "no computer" choice (kind `none`), carries `shell` (`computer`, `local` or `none`, in this server's folder mode), `host_tools` (exactly the tools a run of that choice gets: the file tools always, `bash` with a shell, the five background tools on a computer) and, unless its shell is `computer`, a `shell_note` saying in words what it leaves out. Saving an agent follows the same rule. With Archil storage, an agent with no computer saves with `bash`, which runs in a fresh container on the folder's own storage, and is refused the background tools. With run folders on the server's own disk, it is still refused `bash`. Each refusal uses the choice's `shell_note` words.
