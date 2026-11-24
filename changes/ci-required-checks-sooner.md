---
packages: repo
kind: ci
---
CI reports its required checks sooner. A pull request from a branch of this repository builds and runs its test shards on Blacksmith, as the merge queue does; a fork's pull request and `main` stay on GitHub's runners. The `any` pool has sixteen shards instead of eleven, and the `lean` check waits for the two lean shards alone instead of for every test shard. The store's suite on Postgres runs as four jobs (`npm run test:pg -- --shard=<k>/<n>` runs one share of its files; without `--shard` it runs them all). `npm run test:affected` no longer picks tests for a changed file because a path through other folders ends in the same file name.
