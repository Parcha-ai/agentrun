## Provider PRs

For a new or changed computer provider ([how to contribute one](https://github.com/Parcha-ai/agentrun/blob/main/packages/computer/PROVIDERS.md#how-to-contribute-a-provider)); other PRs can delete this section.

- [ ] Conformance report attached (`npm run conformance -w @parcha/agentrun-computer -- --provider <vendor>`, with the vendor's own key)
- [ ] 0 computers left over (the report's cleanup and the sweep's `"stillThere":[]`)
- [ ] The vendor's limits named (what it refuses or skips, and why)
- [ ] The key's env name: `COMPUTER_<VENDOR>_API_KEY`
