---
packages: repo
kind: ci
---
The console's build fails when its browser bundle would ship a credential. At the end of `vite build`, `apps/console/credential-gate.mjs` reads every emitted script and text file, `THIRD-PARTY-NOTICES.txt` and `index.html` included, and stops on a private key, a GitHub, OpenAI, Anthropic, Slack or AWS key, a JWT, or a URL with a password in it, or on a test, fixture, sample, mock or story from `apps/console/src` in the bundle. The error names the file and the kind of credential, never the text it matched, and hides a file name that itself looks like a credential. Storybook's build, which is not shipped, skips the check.
