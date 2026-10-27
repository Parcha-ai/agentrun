---
packages: repo
kind: fix
---
**The dependency inventory leaves out a third-party package's optional peer that nothing requires at runtime**
- The lockfile records an optional peer when the repository installs it for its own development (a test runner an auth library names), and the inventory followed it and everything under it as if consumers shipped it, which put a dev-only bundler's MPL-2.0 CSS engine under release review. A third-party package's optional peer now ships only where a runtime dependency requires it. A workspace package's own optional peers (the host it runs in, an adapter's SDK) are still followed.
- On this lock no package leaves the inventory: `undici` and `zod` drop the packages that reached them only through `openai`'s and `@anthropic-ai/sdk`'s optional peers from their "Used by" lists.
