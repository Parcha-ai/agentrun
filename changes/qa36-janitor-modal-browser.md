---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
Three fixes from a live QA run:
- **Docker janitor.** The Docker provider's `list()` and `sweep()` no longer fail on a container that has the computer label but was made with no `--mount`. Docker omits `HostConfig.Mounts` when it is empty, and the list template read it as a required key, so one such container failed the janitor's whole pass ("template parsing error … map has no entry for key \"Mounts\"").
- **Modal with an Archil folder.** A Modal sandbox with the run's Archil folder is no longer refused at Modal for its tags (Modal caps a sandbox's tags at 512 bytes, names and values together; a 20-character agent id came to 533). The spec tag now records only what the provider can't infer. That works up to an agent id of 128 characters on the default image. A spec whose tags would still be over 512 bytes is refused at `check()` in words that name each tag's size, before anything is sent to Modal.
- **Browser tool on a browser computer.** An agent whose computer is a browser (Browserbase on the keys saved in Settings → Computers, or Local Chrome) runs its `browser` tool on that computer. Its runs no longer get a 409 that asks for a Tool keys entry, and the run's Screen tab shows that computer.

Who breaks: a Modal computer with an Archil folder made by an earlier release records its mount in the old tag format. `attach` refuses it and `list` reports its mount in words. The janitor still ends it at its deadline, or delete it.
